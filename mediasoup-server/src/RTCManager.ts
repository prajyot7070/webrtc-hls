import { Worker, Router, WebRtcTransport, Transport, Producer, Consumer, RtpCodecCapability, MediaKind, RtpParameters, DtlsParameters } from "mediasoup/node/lib/types";
import { HLSManager } from "./HLSManager";

// Add a debug logger utility
const debug = (message: string, ...args: any[]) => {
  console.log(`[RTC_MANAGER] ${new Date().toISOString()} - ${message}`, ...args);
};

interface TransportInfo {
  transport: WebRtcTransport;
  producerTransports: Map<string, Transport>; //<userId, Transport>
  consumerTransports: Map<string, Transport>; //<userId, Transport>
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}


export class RTCManager {
  private worker: Worker;
  private router?: Router;
  private rooms: Map<string, TransportInfo> = new Map(); //<token, TransportInfo>
  private hlsManager?: HLSManager;
  
  constructor(worker: Worker) {
    debug('RTCManager constructor called');
    this.worker = worker;
    this.initializeRouter();
    debug('RTCManager initialization started');
  }

  private async initializeRouter() {
    debug('Initializing router with media codecs');
    const mediaCodecs: RtpCodecCapability[] = [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1,
        },
      }
    ];
    this.router = await this.worker.createRouter({mediaCodecs});
    debug('Router initialized successfully with ID:', this.router.id);
    
    // Initialize HLS Manager
    this.hlsManager = new HLSManager(this.router);
    debug('HLS Manager initialized');
  }

  private async createWebRtcTransport(): Promise<WebRtcTransport> {
    debug('Creating WebRTC transport');
    const transport = await this.router!.createWebRtcTransport({
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: '127.0.0.1',
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    });
    debug(`WebRTC transport created with ID: ${transport.id}`);
    return transport;
  }

  async getRtpCapabilities() {
    debug('Getting router RTP capabilities');
    const capabilities = this.router?.rtpCapabilities;
    debug('Router RTP capabilities retrieved');
    return capabilities;
  }

  async createTransport(roomId: string, userId: string) {    
    debug(`Creating transport for user ${userId} in room ${roomId}`);
    if (!this.router) {
      debug('Error: Router was not initialized');
      throw new Error("Router was not initialized");
    }
    let transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Room ${roomId} not found, creating new room`);
      transportInfo = {
        transport: await this.createWebRtcTransport(),
        producerTransports: new Map(),
        consumerTransports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      };
      this.rooms.set(roomId, transportInfo);
      debug(`Room ${roomId} created successfully`);
    }
    debug(`Creating producer and consumer transports for user ${userId}`);
    const producerTransport = await this.createWebRtcTransport();
    const consumerTransport = await this.createWebRtcTransport();

    transportInfo.producerTransports.set(userId, producerTransport);
    transportInfo.consumerTransports.set(userId, consumerTransport);
    debug(`Producer transport ID: ${producerTransport.id}, Consumer transport ID: ${consumerTransport.id}`);
    const result = {
      producerTransportParams : {
      id: producerTransport.id,
      iceParameters: producerTransport.iceParameters,
      iceCandidates: producerTransport.iceCandidates,
      dtlsParameters: producerTransport.dtlsParameters,
      },
      consumerTransportParams : {
        id: consumerTransport.id,
        iceParameters: consumerTransport.iceParameters,
        iceCandidates: consumerTransport.iceCandidates,
        dtlsParameters: consumerTransport.dtlsParameters,
      }
    };
    debug(`Transport parameters prepared for user ${userId}`);
    return result;
  }

  async connectTransport(roomId: string, userId: string, transportId: string, dtlsParameters: DtlsParameters) {
    debug(`Connecting transport: ${transportId} for user ${userId} in room ${roomId}`);
    const transportInfo = this.rooms.get(roomId); 
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }

    debug(`Looking for transport ${transportId} for user ${userId}`);
    const transport = transportInfo.producerTransports.get(userId)?.id === transportId
      ? transportInfo.producerTransports.get(userId)
      : transportInfo.consumerTransports.get(userId)?.id === transportId
        ? transportInfo.consumerTransports.get(userId)
        : undefined;

    if (!transport) {
      debug(`Error: Transport ${transportId} not found for user ${userId}`);
      throw new Error("Transport not found");
    }
    debug(`Found transport ${transportId} for user ${userId}`);

    try {
      debug(`Attempting to connect transport ${transportId} with DTLS parameters`);
      await transport.connect({dtlsParameters});
      debug(`Successfully connected transport ${transportId}`);
    } catch (error) {
      debug(`Error connecting transport ${transportId}:`, error);
      throw error;
    }
  }

  
  async produce(roomId: string, userId: string, transportId: string, kind: MediaKind, rtpParameters: RtpParameters) {
    debug(`Producing media | roomId: ${roomId}, userId: ${userId}, transportId: ${transportId}, kind: ${kind}`);
    const transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }

    const producerTransport = transportInfo.producerTransports.get(userId);
    if (!producerTransport || producerTransport.id !== transportId) {
      debug(`Error: Producer transport ${transportId} not found for user ${userId}`);
      throw new Error("Producer transport not found");
    }
    debug(`Creating producer with kind: ${kind}`);
    const producer = await producerTransport.produce({ 
      kind: kind,
      rtpParameters: rtpParameters,
      appData: { userId: userId },
      keyFrameRequestDelay: 1000,
    });
    transportInfo.producers.set(producer.id, producer);
    debug(`Producer created successfully with ID: ${producer.id}`);
    // console.log("transportInfo.producers :- ",transportInfo.producers);

    return { transportId: transportId, producerId: producer.id };
  }

  async getProducers(roomId: string, requestingUserId: string): Promise<Array<{ producerId: string; kind: 'audio' | 'video'; peerId: string }>> {
  debug(`Getting producers for everyone except user ${requestingUserId} in room ${roomId}`);
  const room = this.rooms.get(roomId);
  if (!room) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
  }
  if (!room.producers || room.producers.size === 0) {
      debug(`No producers found in room ${roomId}`);
      return [];
  }

  const producersToReturn = Array.from(room.producers.values())
      .filter(producer => producer.appData && producer.appData.userId && producer.appData.userId !== requestingUserId)
      .map(producer => ({
          producerId: producer.id,
          kind: producer.kind as 'audio' | 'video',
          peerId: producer.appData.userId as string
      }));
    
    debug(`Producers retrieved successfully | Producers List: ${JSON.stringify(producersToReturn)}`);
    return producersToReturn;
  }




async stopHLS(roomId: string) {
    debug(`Stopping HLS for room ${roomId}`);
    
    if (!this.hlsManager) {
      debug(`Error: HLS Manager not initialized`);
      throw new Error(`HLS Manager not initialized`);
    }

    // Use the HLSManager to stop HLS streaming
    await this.hlsManager.stopHLS(roomId);
    debug(`HLS stopped for room ${roomId}`);
  }

async startHLS(roomId: string) {
    debug(`Attempting HLS for room ${roomId}`);
    
    if (!this.hlsManager) {
      debug(`Error: HLS Manager not initialized`);
      throw new Error(`HLS Manager not initialized`);
    }

    const room = this.rooms.get(roomId);

    if (!room) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error(`Room ${roomId} not found`);
    }

    // Use the HLSManager to start HLS streaming
    return await this.hlsManager.startHLS(roomId, room.producers);
  }


  async consume(roomId: string, userId: string, transportId: string, producerId: string, rtpCapabilities: any) {
    debug(`Consuming media | roomId: ${roomId}, userId: ${userId}, transportId: ${transportId}, producerId: ${producerId}`);
    const transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }
    
    const producer = transportInfo.producers.get(producerId);
    if (!producer) {
      debug(`Error: Producer ${producerId} not found`);
      throw new Error("Producer not found");
    }

    debug(`Checking if router can consume producer ${producerId} with given RTP capabilities`);

    if (!this.router!.canConsume({producerId: producer.id, rtpCapabilities: rtpCapabilities})) {
      debug(`Error: Cannot consume producer ${producerId} - incompatible RTP capabilities`);
      throw new Error("Cannot consume this producer");
    }
    debug(`Router can consume producer ${producerId}`);

    debug(`Looking for consumer transport ${transportId} for user ${userId}`);
    const consumerTransport = transportInfo.consumerTransports.get(userId);
    if (!consumerTransport || consumerTransport.id !== transportId) {
      debug(`Error: Consumer transport not found or ID mismatch | expected: ${transportId}, found: ${consumerTransport?.id}`);
      throw new Error('Consumer transport not found');
    }
    debug(`Found consumer transport ${transportId}`);

    debug(`Creating consumer for producer ${producer.id} on transport ${consumerTransport.id}`);
    const consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities: rtpCapabilities,
      paused: true,
    });

    debug(`Consumer created successfully | ID: ${consumer.id}, kind: ${consumer.kind}`);

    transportInfo.consumers.set(consumer.id, consumer);
    debug(`Consumer ${consumer.id} added to consumers map`);

    const result = {
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerId: consumer.producerId,
      paused: consumer.paused,
    };
    debug(`Consumer parameters prepared for user ${userId}`);
    return result; 
  }

  async resumeConsumer(roomId: string, userId: string, consumerId: string) {
    debug(`Resuming consumer ${consumerId} for user ${userId} in room ${roomId}`);
    const transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }
    const consumer = transportInfo.consumers.get(consumerId);
    if (!consumer) {
      debug(`Error: Consumer ${consumerId} not found`);
      throw new Error("Consumer not found");
    }
    debug(`Resuming consumer ${consumerId}`);
    await consumer.resume();
    debug(`Consumer ${consumerId} resumed successfully`);
  }

async removeUser(roomId: string, userId: string) {
    debug(`Removing user ${userId} from room ${roomId}`);
    const transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }
    
    //close user's producer transport
    const producerTransport = transportInfo.producerTransports.get(userId);
    if (producerTransport) {
      debug(`Closing producer transport ${producerTransport.id} for user ${userId}`);
      await producerTransport.close();
      transportInfo.producerTransports.delete(userId);
      debug(`Producer transport closed and removed for user ${userId}`);
    }
    
    //close user's consumer transport
    const consumerTransport = transportInfo.consumerTransports.get(userId);
    if (consumerTransport) {
      debug(`Closing consumer transport ${consumerTransport.id} for user ${userId}`);
      await consumerTransport.close();
      transportInfo.consumerTransports.delete(userId);
      debug(`Consumer transport closed and removed for user ${userId}`);
    }
    
    debug(`User ${userId} removed from room ${roomId}`);
  }

async closeRoom(roomId: string) {
    debug(`Closing room ${roomId}`);
    const transportInfo = this.rooms.get(roomId);
    if (!transportInfo) {
      debug(`Error: Room ${roomId} not found`);
      throw new Error("Room not found");
    }
    
    debug(`Closing all producer transports in room ${roomId}`);
    for (const transport of transportInfo.producerTransports.values()) {
      await transport.close();
    }
    
    debug(`Closing all consumer transports in room ${roomId}`);
    for (const transport of transportInfo.consumerTransports.values()) {
      await transport.close();
    }
    
    this.rooms.delete(roomId);
    debug(`Room ${roomId} closed and removed`);
  }

}