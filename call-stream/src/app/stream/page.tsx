'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Device } from 'mediasoup-client';
import { resolve } from 'path';
import { WASI } from 'wasi';

const StreamPage = () => {
  // Connection states
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [roomId, setRoomId] = useState<string>(`room-${Math.random().toString(36).substring(2, 7)}`);
  const [userId, setUserId] = useState<string>(`user-${Math.random().toString(36).substring(2, 9)}`);
  
  // MediaSoup related states
  const [device, setDevice] = useState<Device | null>(null);
  const [sendTransport, setSendTransport] = useState<any>(null);
  const [recvTransport, setRecvTransport] = useState<any>(null);
  const [producers, setProducers] = useState<Map<string, any>>(new Map());
  const [consumers, setConsumers] = useState<Map<string, any>>(new Map());
  
  // Media states
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [mediaDevices, setMediaDevices] = useState<{
    audio: MediaDeviceInfo[],
    video: MediaDeviceInfo[]
  }>({ audio: [], video: [] });
  const [selectedDevices, setSelectedDevices] = useState<{
    audioId: string,
    videoId: string
  }>({ audioId: "", videoId: "" });
  
  // Error handling
  const [error, setError] = useState<string | null>(null);
  
  // WebSocket reference
  const wsRef = useRef<WebSocket | null>(null);
  
  // Video refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  
  // Transport refs for immediate access
  const recvTransportRef = useRef<any>(null);
  
  let newDevice: Device | null = null;

  // Initialize media devices
  useEffect(() => {
    const loadDevices = async () => {
      try {
        // Request permissions first to ensure we get accurate device lists
        await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
          .then(stream => {
            // Stop tracks immediately as we just need permission
            stream.getTracks().forEach(track => track.stop());
          });
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        setMediaDevices({
          audio: devices.filter(device => device.kind === 'audioinput'),
          video: devices.filter(device => device.kind === 'videoinput')
        });
        
        // Set default devices if available
        if (devices.some(device => device.kind === 'audioinput')) {
          setSelectedDevices(prev => ({
            ...prev,
            audioId: devices.find(d => d.kind === 'audioinput')?.deviceId || ""
          }));
        }
        
        if (devices.some(device => device.kind === 'videoinput')) {
          setSelectedDevices(prev => ({
            ...prev,
            videoId: devices.find(d => d.kind === 'videoinput')?.deviceId || ""
          }));
        }
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Could not access media devices. Please check permissions.');
      }
    };
    
    loadDevices();
    
    // Listen for device changes
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
    };
  }, [device]);
  
  // Function to start HLS stream
  const startStream = () => {
    if (!isConnected || !wsRef.current) {
      setError('You must join the room before starting the stream');
      return;
    }
    
    try {
      wsRef.current.send(JSON.stringify({
        type: 'start-hls',
        roomId,
        userId
      }));
      console.log('Sent start-hls request to signaling server');
      setIsStreaming(true);
    } catch (err) {
      console.error('Error sending start-hls request:', err);
      setError('Failed to start the stream. Please try again.');
    }
  };
  
  // Function to stop HLS stream
  const stopStream = () => {
    if (!isConnected || !wsRef.current) {
      setError('You must be connected to stop the stream');
      return;
    }
    
    try {
      wsRef.current.send(JSON.stringify({
        type: 'stop-hls',
        roomId,
        userId
      }));
      console.log('Sent stop-hls request to signaling server');
      setIsStreaming(false);
    } catch (err) {
      console.error('Error sending stop-hls request:', err);
      setError('Failed to stop the stream. Please try again.');
    }
  };

  // Handle local media stream for preview
  useEffect(() => {
    console.log("setupLocalPreview useEffect triggered.");
    console.log("videoEnabled:", videoEnabled, "audioEnabled:", audioEnabled);
    console.log("selectedDevices:", selectedDevices);
    const setupLocalPreview = async () => {
      if (!videoEnabled && !audioEnabled) {
        if (localStream) {
          localStream.getTracks().forEach(track => track.stop());
          setLocalStream(null);
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = null;
        }
        return;
      }
      
      try {
        console.log("Attempting getUserMedia");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audioEnabled ? { deviceId: selectedDevices.audioId || undefined } : false,
          video: videoEnabled ? { 
            deviceId: selectedDevices.videoId || undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : false
        });
        console.log("getUserMedia resolved successfully");
        
        setLocalStream(stream);
        
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Error accessing media devices for preview:', err);
        setError('Could not access camera or microphone for preview.');
      }
    };
    
    setupLocalPreview();
    
    // Cleanup function
    return () => {
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedDevices.audioId, selectedDevices.videoId, audioEnabled, videoEnabled]);                 
  
  // Connect to signaling server and setup WebRTC
  const connectToRoom = async () => {
    if (isConnecting || isConnected) return;
    
    setIsConnecting(true);
    setError(null);
    
    try {
      // Create WebSocket connection
      const ws = new WebSocket('ws://localhost:4000');
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log('Connected to signaling server');
        // Join room
        ws.send(JSON.stringify({
          type: 'join',
          roomId,
          userId
        }));
        
        // Request router capabilities
        ws.send(JSON.stringify({
          type: 'get-router-capabilities'
        }));
      };
      
      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await handleSignalingMessage(message, ws);
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('Connection error. Please try again.');
        setIsConnecting(false);
      };
      
      ws.onclose = () => {
        console.log('Disconnected from signaling server');
        setIsConnected(false);
        cleanupConnections();
      };
      
      wsRef.current = ws;
    } catch (err) {
      console.error('Error connecting to room:', err);
      setError('Failed to connect to room.');
      setIsConnecting(false);
    }
  };
  
  // Handle different signaling messages
  const handleSignalingMessage = async (message: any, ws: WebSocket) => {
    console.log('Received message:', message);
    
    try {
      switch(message.type) {
        case 'router-capabilities':
          await handleRouterCapabilities(message.capabilities, ws);
          break;
          
        case 'transport-created':
          await handleTransportCreated(message.data, ws);
          break;
          
        case 'transport-connected':
          await handleTransportConnected(message.data, ws);
          break;
          
        case 'produce-success':
          handleProduceSuccess(message.data);
          break;
          
        case 'new-producer':
          await handleNewProducer(message.data, ws);
        break;
          
        case 'consume-success':
          await handleConsumeSuccess(message.data);
          break;
          
        case 'user-joined':
          console.log(`User joined: ${message.userId}`);
          break;
          
        case 'user-left':
          handleUserLeft(message.userId);
          break;
          
        case 'error':
          setError(message.message);
          break;
          
        case 'hls-started':
          console.log('HLS stream started successfully', message.data);
          setIsStreaming(true);
          break;
          
        case 'hls-stopped':
          console.log('HLS stream stopped successfully', message.data);
          setIsStreaming(false);
          break;
          
        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('Error handling message:', err);
      setError('Error handling server message.');
    }
  };
  
  // Initialize MediaSoup device with router capabilities
  const handleRouterCapabilities = async (routerCapabilities: any, ws: WebSocket) => {
    try {
      newDevice = new Device();
      await newDevice.load({ routerRtpCapabilities: routerCapabilities });
      setDevice(newDevice);
      console.log(`setDevice :- ${device} | newDevice :- ${newDevice}`);
      if(!newDevice){
        setError('Failed to initialize media device.');
        return;
      } else {
        console.log('Media device initialized successfully.');
      }
      
      // Request transports
      ws.send(JSON.stringify({
        type: 'create-transport',
        roomId,
        userId
      }));
    } catch (err) {
      console.error('Error loading device:', err);
      setError('Failed to initialize media device.');
    }
  };
  
  // Setup transports for sending and receiving media
  const handleTransportCreated = async (transportData: any, ws: WebSocket) => {
    try {
      if (!newDevice) {
        setError('device not set.');
        return;
      };
      console.log(`transportData :- ${JSON.stringify(transportData)}`);
      
      // Create send transport
      const newSendTransport = newDevice.createSendTransport(transportData.producerTransportParams);
      console.log(`newSendTransport :- ${newSendTransport}`);
      
      newSendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log(`on 'connect' event called inside newSendTransport`);
        console.log(`dtlsParameters :- ${dtlsParameters}`);
        try {
          ws.send(JSON.stringify({
            type: 'connect-transport',
            roomId,
            userId,
            transportId: newSendTransport.id,
            dtlsParameters
          }));
          callback();
        } catch (err) {
          errback(err as Error);
        }
      });
      
      newSendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        console.log(`on 'produce' event called inside newSendTransport`);
        console.log(`kind :- ${kind}`);
        console.log(`rtpParameters :- ${rtpParameters}`);
        try {
          ws.send(JSON.stringify({
            type: 'produce',
            roomId,
            userId,
            produceTransportId: newSendTransport.id,
            kind,
            rtpParameters
          }));
          
          // The server will respond with 'produce-success' containing the producerId
          // We temporarily store this callback to be called later
          console.log(`Storing callback for transportId :- ${newSendTransport.id}`);
          producerCallbacks.set(`${newSendTransport.id}`, {
            resolve: callback,
            reject: errback
          });
        } catch (err) {
          errback(err as Error);
        }
      });
      
      // Create receive transport
      const newRecvTransport = newDevice.createRecvTransport(transportData.consumerTransportParams);
      console.log(`newRecvTransport :- ${newRecvTransport}`);      
      newRecvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log(`on 'connect' event called inside newRecvTransport`);
        console.log(`dtlsParameters :- ${dtlsParameters}`);
        try {
          ws.send(JSON.stringify({
            type: 'connect-transport',
            roomId,
            userId,
            transportId: newRecvTransport.id,
            dtlsParameters
          }));
          callback();
        } catch (err) {
          errback(err as Error);
        }
      });
      
      setSendTransport(newSendTransport);
      setRecvTransport(newRecvTransport);
      
      // Store in ref for immediate access
      recvTransportRef.current = newRecvTransport;
      
      // Now we're connected and ready to produce media
      setIsConnected(true);
      setIsConnecting(false);
      
      // Start producing local media if available
      if (localStream) { 
        console.log(`Calling publishLocalMedia`);
        publishLocalMedia(newSendTransport);
      } else {
        console.log(`localStream :- ${localStream}`);
        console.log(`sendTransport :- ${sendTransport}`);
        console.log(`Not calling publishLocalMedia`);
      }
    } catch (err) {
      console.error('Error setting up transports:', err);
      setError('Failed to setup media transports.');
      setIsConnecting(false);
    }
  };
  
  // Temporary storage for producer callbacks
  const producerCallbacks = new Map();
  
  // Handle transport connected event
  const handleTransportConnected = async (data: any, ws: WebSocket) => {
    // Now we can start producing media
    if (localStream && sendTransport) {
      publishLocalMedia(sendTransport);
    }
  };
  
  // Publish local media streams
  const publishLocalMedia = async (sendTransport: any) => {
    if (!localStream || !sendTransport) return;
    
    try {
      // Produce audio if enabled
      if (audioEnabled) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
          const producer = await sendTransport.produce({ track: audioTrack });
          const newProducers = new Map(producers);
          newProducers.set('audio', producer);
          setProducers(newProducers);
        }
      } else {
        console.log('Audio is disabled');
      }
      
      // Produce video if enabled
      if (videoEnabled) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          const producer = await sendTransport.produce({ 
            track: videoTrack,
            encodings: [
              { maxBitrate: 100000, scaleResolutionDownBy: 3 },
              { maxBitrate: 300000, scaleResolutionDownBy: 2 },
              { maxBitrate: 900000, scaleResolutionDownBy: 1 }
            ],
            codecOptions: {
              videoGoogleStartBitrate: 1000
            }
          });
          const newProducers = new Map(producers);
          newProducers.set('video', producer);
          setProducers(newProducers);
        } else {
          console.log('Video track is not available');
        }
      } else {
        console.log('Video is disabled');
      }
    } catch (err) {
      console.error('Error publishing media:', err);
      setError('Failed to publish media stream.');
    }
  };
  
  // Handle successful produce response
  const handleProduceSuccess = (data: any) => {
    const { transportId, producerId } = data;
    // Resolve the producer callback if we have one stored
    // This would typically be identified by kind and transport ID
    // For simplicity, we're not implementing this fully
    console.log(`ProducerId :- ${producerId} | transportId :- ${transportId}`);
    const callback = producerCallbacks.get(`${transportId}`);
    if (callback) {
      callback.resolve({id: producerId});
      producerCallbacks.delete(`${transportId}`);
    } else {
      console.log(`No callback found for transportId :- ${transportId}`);
      console.warn(`No callback found for transportId :- ${transportId}`);
    }
  };
  
  // Handle new producer from other participant
  const handleNewProducer = async (data: any, ws: WebSocket) => {
    // Use the ref first, then fall back to state if needed
    const transport = recvTransportRef.current || recvTransport;
    
    if (!transport || !newDevice) {
      console.log(`recvTransport :- ${JSON.stringify(transport)} | newDevice :- ${JSON.stringify(newDevice)} \n either recvTransport or newDevice is not set.`);
      return;
    }
    
    try {
      const { producerId } = data;
      console.log(`producerId :- ${producerId}`);
      // Request to consume this producer
      ws.send(JSON.stringify({
      type: 'consume',
      consumeTransportId: transport.id,
      producerId,
      rtpCapabilities: newDevice.rtpCapabilities,
      roomId: roomId,
      
    }));
    } catch (err) {
      console.error('Error handling new producer:', err);
    }
  };
  
  // Handle consume success response
  const handleConsumeSuccess = async (data: any) => {
    if (!recvTransportRef.current) return;
    
    try {
      const { consumerId, producerId, kind, rtpParameters, paused } = data;
      console.log(`consumerId :- ${consumerId} | producerId :- ${producerId} | kind :- ${kind} | rtpParameters :- ${JSON.stringify(rtpParameters)} | paused :- ${paused}`);
      // Create consumer
      const consumer = await recvTransportRef.current.consume({
        id: consumerId,
        producerId,
        kind,
        rtpParameters
      });
      
      // Store the consumer
      const newConsumers = new Map(consumers);
      newConsumers.set(consumerId, consumer);
      setConsumers(newConsumers);
      
      // Create a new MediaStream for this consumer
      const stream = new MediaStream([consumer.track]);
      
      // Store the stream
      const newRemoteStreams = new Map(remoteStreams);
      newRemoteStreams.set(producerId, stream);
      setRemoteStreams(newRemoteStreams);

      if (paused) {
        console.log(`Consumer ${consumerId} is paused, resuming...`);
        wsRef.current?.send(JSON.stringify({
          type: 'resume-consumer',
          consumerId,
          roomId,
          userId
        }));
      } else {
        console.log(`Consumer ${consumerId} is not paused, resuming...`);
        consumer.resume();
      }
      
      // Resume the consumer
      // consumer.resume();
    } catch (err) {
      console.error('Error consuming stream:', err);
    }
  };
  
  // Handle user leaving
  const handleUserLeft = (userId: string) => {
    // Remove the user's streams
    const newRemoteStreams = new Map(remoteStreams);
    
    // In a real implementation, you would know which streams belong to which user
    // For now, we're just logging it
    console.log(`User ${userId} left. Would remove their streams here.`);
  };
  
  // Disconnect from room
  const disconnectFromRoom = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    cleanupConnections();
    setIsConnected(false);
  };
  
  // Clean up all connections
  const cleanupConnections = () => {
    // Close and cleanup producers
    producers.forEach((producer) => {
      producer.close();
    });
    setProducers(new Map());
    
    // Close and cleanup consumers
    consumers.forEach((consumer) => {
      consumer.close();
    });
    setConsumers(new Map());
    
    // Close transports
    if (sendTransport) {
      sendTransport.close();
      setSendTransport(null);
    }
    
    if (recvTransport) {
      recvTransport.close();
      setRecvTransport(null);
    }
    
    // Clear remote streams
    setRemoteStreams(new Map());
  };
  
  // Toggle audio/video
  const toggleAudio = () => {
    const newAudioState = !audioEnabled;
    setAudioEnabled(newAudioState);
    
    // Update existing producer if we're connected
    if (isConnected && producers.has('audio')) {
      const audioProducer = producers.get('audio');
      if (!newAudioState) { // If turning audio off
        audioProducer?.pause();
      } else { // If turning audio on
        audioProducer?.resume();
      }
    }
  };
  
  const toggleVideo = () => {
    const newVideoState = !videoEnabled;
    setVideoEnabled(newVideoState);
    
    // Update existing producer if we're connected
    if (isConnected && producers.has('video')) {
      const videoProducer = producers.get('video');
      if (!newVideoState) { // If turning video off
        videoProducer?.pause();
      } else { // If turning video on
        videoProducer?.resume();
      }
    }
  };
  
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Video Stream</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700">Room ID</label>
        <input 
          type="text" 
          value={roomId} 
          onChange={(e) => setRoomId(e.target.value)}
          disabled={isConnected || isConnecting}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
        />
      </div>
      
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700">Your Name</label>
        <input 
          type="text" 
          value={userId} 
          onChange={(e) => setUserId(e.target.value)}
          disabled={isConnected || isConnecting}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
        />
      </div>
      
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Camera</label>
          <select
            value={selectedDevices.videoId}
            onChange={(e) => setSelectedDevices(prev => ({ ...prev, videoId: e.target.value }))}
            disabled={isConnected || isConnecting}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          >
            <option value="">Select camera</option>
            {mediaDevices.video.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${device.deviceId.substring(0, 5)}...`}
              </option>
            ))}
          </select>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700">Microphone</label>
          <select
            value={selectedDevices.audioId}
            onChange={(e) => setSelectedDevices(prev => ({ ...prev, audioId: e.target.value }))}
            disabled={isConnected || isConnecting}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          >
            <option value="">Select microphone</option>
            {mediaDevices.audio.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${device.deviceId.substring(0, 5)}...`}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      <div className="flex space-x-4 mb-4">
        <button
          onClick={toggleVideo}
          className={`px-4 py-2 rounded ${videoEnabled ? 'bg-green-500 text-white' : 'bg-gray-300'}`}
        >
          {videoEnabled ? 'Camera On' : 'Camera Off'}
        </button>
        
        <button
          onClick={toggleAudio}
          className={`px-4 py-2 rounded ${audioEnabled ? 'bg-green-500 text-white' : 'bg-gray-300'}`}
        >
          {audioEnabled ? 'Mic On' : 'Mic Off'}
        </button>
        
        {!isConnected ? (
          <button
            onClick={connectToRoom}
            disabled={isConnecting}
            className="px-4 py-2 bg-blue-500 text-white rounded"
          >
            {isConnecting ? 'Connecting...' : 'Join Room'}
          </button>
        ) : (
          <>
            <button
              onClick={disconnectFromRoom}
              className="px-4 py-2 bg-red-500 text-white rounded mr-2"
            >
              Leave Room
            </button>
            {!isStreaming ? (
              <button
                onClick={startStream}
                className="px-4 py-2 bg-purple-500 text-white rounded"
              >
                Start Stream
              </button>
            ) : (
              <button
                onClick={stopStream}
                className="px-4 py-2 bg-red-500 text-white rounded"
              >
                Stop Stream
              </button>
            )}
          </>
        )}
      </div>
      
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-2">Local Preview</h2>
        <div className="bg-gray-100 rounded-lg overflow-hidden aspect-video">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        </div>
      </div>
      
      {remoteStreams.size > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-2">Remote Participants</h2>
          <div className="grid grid-cols-2 gap-4">
            {Array.from(remoteStreams).map(([id, stream]) => (
              <div key={id} className="bg-gray-100 rounded-lg overflow-hidden aspect-video">
                <video
                  autoPlay
                  playsInline
                  ref={(el) => {
                    if (el) {
                      el.srcObject = stream;
                    }
                  }}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default StreamPage;