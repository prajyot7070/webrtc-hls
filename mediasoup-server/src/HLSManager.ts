import { Router, PlainTransport, Consumer } from "mediasoup/node/lib/types";
import path from 'path';
import fs from 'fs';
import { ChildProcess, spawn } from 'child_process';

// Add a debug logger utility
const debug = (message: string, ...args: any[]) => {
  console.log(`[HLS_MANAGER] ${new Date().toISOString()} - ${message}`, ...args);
};

interface HlsProcessInfo {
  ffmpegProcess: ChildProcess;
  audioPlainTransport: PlainTransport[];
  videoPlainTransport: PlainTransport[];
  audioConsumers: Consumer[];
  videoConsumers: Consumer[];
  hlsOutputPath: string;
  outputDir: string;
  keyframeInterval?: NodeJS.Timeout;
}

// Map to store HLS processes by room ID
const hlsProcesses: Map<string, HlsProcessInfo> = new Map(); //<roomId, HlsProcessInfo>

export class HLSManager {
  private router: Router;

  constructor(router: Router) {
    debug('HLSManager constructor called');
    this.router = router;
  }

  async startHLS(roomId: string, producers: Map<string, any>) {
    debug(`Attempting HLS for room ${roomId}`);
    if (hlsProcesses.has(roomId)) {
        debug(`HLS already started for room ${roomId}`);
        return;
    }

    if (!this.router) {
        debug(`Error: Router not found`);
        throw new Error(`Router not found`);
    }

    const allProducers = Array.from(producers.values())
        .filter(producer => producer.appData && producer.appData.userId);
    debug(`All producers found for room ${roomId} | Producers List: ${JSON.stringify(allProducers.map(p => ({id: p.id, kind: p.kind})))}`);

    const audioProducers = allProducers.filter(producer => producer.kind === 'audio');
    const videoProducers = allProducers.filter(producer => producer.kind === 'video');

    debug(`Audio producers found for room ${roomId} | Audio Producers List: ${JSON.stringify(audioProducers.map(p => p.id))}`);
    debug(`Video producers found for room ${roomId} | Video Producers List: ${JSON.stringify(videoProducers.map(p => p.id))}`);

    if (audioProducers.length === 0 || videoProducers.length === 0) {
        debug(`Error: No audio or video producers found for room ${roomId} to start HLS.`);
        throw new Error("No audio or video producers found for HLS.");
    }

    // Define FFmpeg listening IPs and Ports
    const FFMPEG_HOST = '127.0.0.1';
    const FFMPEG_AUDIO_PORT = 5004;
    const FFMPEG_VIDEO_BASE_PORT = 5008;
    const HLS_PLAYLIST_FILENAME = 'index.m3u8';

    // Arrays to store all transports and consumers for cleanup
    const allTransports: PlainTransport[] = [];
    const allConsumers: Consumer[] = [];

    try {
        // --- 1. Create Audio PlainTransport and Consumers ---
        const audioPlainTransport = await this.router.createPlainTransport({
            listenIp: { ip: FFMPEG_HOST, announcedIp: undefined },
            enableSctp: false,
            comedia: false, // Changed to true for better compatibility
            rtcpMux: false
        });
        allTransports.push(audioPlainTransport);
        debug(`Audio PlainTransport created for HLS in room ${roomId}: ${audioPlainTransport.id}`);
        debug(`AUDIO Transport IP: ${audioPlainTransport.tuple.localIp} | AUDIO Transport Port: ${audioPlainTransport.tuple.localPort}`);

        await audioPlainTransport.connect({
            ip: FFMPEG_HOST,
            port: FFMPEG_AUDIO_PORT,
            rtcpPort: FFMPEG_AUDIO_PORT + 1
        });
        debug(`Audio PlainTransport connected to FFmpeg at ${FFMPEG_HOST}:${FFMPEG_AUDIO_PORT}`);
        
        // Create separate audio transport and consumers (all on the same transport for mixing)
        const audioTransports: PlainTransport[] = [];
        const audioConsumers: Consumer[] = [];
        for (let i = 0; i < audioProducers.length; i++) {
          const audioPort = FFMPEG_AUDIO_PORT + (i * 2);
          const audioTransport = await this.router.createPlainTransport({
            listenIp: { ip: FFMPEG_HOST, announcedIp: undefined },
            enableSctp: false,
            comedia: false, // Changed to true for better compatibility
            rtcpMux: false
          });
          audioTransports.push(audioTransport);
          allTransports.push(audioTransport);
          debug(`Audio Transport ${i + 1} created for HLS in room ${roomId}: ${audioTransport.id}`);
          debug(`AUDIO Transport ${i + 1} IP: ${audioTransport.tuple.localIp} | AUDIO Transport Port: ${audioTransport.tuple.localPort}`);

          await audioTransport.connect({
              ip: FFMPEG_HOST,
              port: audioPort,
              rtcpPort: audioPort + 1
          });
          debug(`Audio Transport ${i + 1} connected to FFmpeg at ${FFMPEG_HOST}:${audioPort}`);

          const audioConsumer = await audioTransport.consume({
                producerId: audioProducers[i].id,
                rtpCapabilities: this.router.rtpCapabilities,
                paused: true,
            });
            
            // Set preferred layers for audio if available (for better quality)
            if (audioConsumer.rtpParameters.encodings && audioConsumer.rtpParameters.encodings.length > 0) {
                try {
                    // Try to use highest quality audio layer if available
                    await audioConsumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 });
                    debug(`Set preferred layers for audio consumer ${audioConsumer.id}`);
                } catch (e: any) {
                    debug(`Could not set preferred layers for audio: ${e.message}`);
                }
            }
            
            audioConsumers.push(audioConsumer);
            allConsumers.push(audioConsumer);
            debug(`Audio consumer created on Audio PlainTransport for producer ${audioProducers[i].id}`);
        }

        // --- 2. Create SEPARATE Video PlainTransports and Consumers ---
        const videoTransports: PlainTransport[] = [];
        const videoConsumers: Consumer[] = [];

        for (let i = 0; i < videoProducers.length && i < 2; i++) {
            const videoPort = FFMPEG_VIDEO_BASE_PORT + (i * 4);
            
            // Create separate transport for each video
            const videoTransport = await this.router.createPlainTransport({
                listenIp: { ip: FFMPEG_HOST, announcedIp: undefined },
                enableSctp: false,
                comedia: false, // Changed to true
                rtcpMux: false
            });
            
            videoTransports.push(videoTransport);
            allTransports.push(videoTransport);
            debug(`Video PlainTransport ${i + 1} created for HLS in room ${roomId}: ${videoTransport.id}`);

            // Connect to specific port
            await videoTransport.connect({
                ip: FFMPEG_HOST,
                port: videoPort,
                rtcpPort: videoPort + 1
            });
            debug(`Video PlainTransport ${i + 1} connected to FFmpeg at ${FFMPEG_HOST}:${videoPort}`);

            // Create consumer on this transport
            const videoConsumer = await videoTransport.consume({
                producerId: videoProducers[i].id,
                rtpCapabilities: this.router.rtpCapabilities,
                paused: true,
            });
            
            videoConsumers.push(videoConsumer);
            allConsumers.push(videoConsumer);
            
            // Request keyframe multiple times to ensure we get one
            videoConsumer.requestKeyFrame();
            setTimeout(() => videoConsumer.requestKeyFrame(), 500);
            setTimeout(() => videoConsumer.requestKeyFrame(), 1000);
            debug(`Multiple keyframes requested for video consumer ${i + 1}`);
            debug(`Video consumer ${i + 1} created on Video PlainTransport for producer ${videoProducers[i].id}`);
        }

        // --- 3. Create output directory and SDP files ---
        const HLS_BASE_DIR = path.join(process.cwd(), 'hls');
        const outputDir = path.join(HLS_BASE_DIR, roomId);

        // Thoroughly clean up existing directory to avoid conflicts with previous sessions
        if (fs.existsSync(outputDir)) {
            try {
                // First try to remove the entire directory and recreate it
                fs.rmSync(outputDir, { recursive: true, force: true });
                debug(`Removed existing output directory: ${outputDir}`);
                fs.mkdirSync(outputDir, { recursive: true });
                debug(`Recreated output directory for room ${roomId}: ${outputDir}`);
            } catch (err) {
                debug(`Error removing directory: ${err}`);
                // Fallback: try to remove files individually
                try {
                    const files = fs.readdirSync(outputDir);
                    for (const file of files) {
                        try {
                            fs.unlinkSync(path.join(outputDir, file));
                        } catch (fileErr) {
                            debug(`Error removing file ${file}: ${fileErr}`);
                        }
                    }
                    debug(`Cleaned up existing files in output directory: ${outputDir}`);
                } catch (listErr) {
                    debug(`Error listing directory contents: ${listErr}`);
                }
            }
        } else {
            fs.mkdirSync(outputDir, { recursive: true });
            debug(`Created output directory for room ${roomId}: ${outputDir}`);
        }

        // Create audio SDP
        for (let i = 0; i < audioConsumers.length; i++) {
          const audioPort = FFMPEG_AUDIO_PORT + (i * 2);
          const audioSDP = await this.createAudioSDP(audioConsumers[i], audioPort, i);
          fs.writeFileSync(path.join(outputDir, `audio${i + 1}.sdp`), audioSDP);
          debug(`Created audio${i + 1}.sdp on port ${audioPort}`);
        }

        // Create video SDP files with proper stream indexing
        for (let i = 0; i < videoConsumers.length && i < 2; i++) {
            const videoPort = FFMPEG_VIDEO_BASE_PORT + (i * 4);
            const videoSDP = await this.createVideoSDP(videoConsumers[i], videoPort, i);
            fs.writeFileSync(path.join(outputDir, `video${i + 1}.sdp`), videoSDP);
            debug(`Created video${i + 1}.sdp on port ${videoPort}`);
        }

        // --- 4. Build Enhanced FFmpeg command ---
        const ffmpegArgs = [
          '-loglevel', 'debug',
          '-report',
          '-y', // Overwrite output files
          
          // Global options - optimized for sync
          '-fflags', '+genpts+discardcorrupt+nobuffer',
          '-avoid_negative_ts', 'make_zero',
          '-thread_queue_size', '1024',
          '-protocol_whitelist', 'file,udp,rtp,rtcp,crypto,data',
          '-analyzeduration', '5000000',
          '-probesize', '2000000',
          '-use_wallclock_as_timestamps', '1',
          '-max_delay', '500000',
          '-copytb', '1',             // Use input stream timebase
      
        ];

        //Add audio inputs
        for (let i = 0; i < audioConsumers.length; i++) {
          debug(`Adding audio input ${i + 1} to FFmpeg command`);
          ffmpegArgs.push('-protocol_whitelist', 'file,udp,rtp,rtcp,crypto,data');
          ffmpegArgs.push('-f', 'sdp');
          ffmpegArgs.push('-c:a', 'libopus');
          ffmpegArgs.push('-thread_queue_size', '1024');
          ffmpegArgs.push('-i', path.join(outputDir, `audio${i + 1}.sdp`));
        }
      
        // Add video inputs - NO DUPLICATE OPTIONS
        for (let i = 0; i < videoConsumers.length && i < 2; i++) {
            debug(`Adding video input ${i + 1} to FFmpeg command`);
            ffmpegArgs.push('-protocol_whitelist', 'file,udp,rtp,rtcp,crypto,data');
            ffmpegArgs.push('-f', 'sdp');
            ffmpegArgs.push('-i', path.join(outputDir, `video${i + 1}.sdp`));
        }

        //filter_complex
        const firstVideoInputIndex = audioConsumers.length;
        let audioMixString = '';
        let filterComplexString = '';
        
        // Ultra-simplified audio handling for maximum reliability
        if (audioConsumers.length > 0) {
          // For each audio stream, apply more robust processing for better sync
          for (let i = 0; i < audioConsumers.length; i++) {
            // Enhanced audio processing: resampling with precise timing, volume normalization, and sync correction
            audioMixString += `[${i}:a]aresample=48000:first_pts=0,asetpts=PTS-STARTPTS,asetnsamples=n=1024:p=1,volume=1.0[a${i}];`;
          }
          
          // Handle mixing based on number of streams
          if (audioConsumers.length > 1) {
            let mixInputs = '';
            for (let i = 0; i < audioConsumers.length; i++) {
              mixInputs += `[a${i}]`;
            }
            // Enhanced mixing with better parameters for sync
            filterComplexString = audioMixString + 
              `${mixInputs}amix=inputs=${audioConsumers.length}:dropout_transition=0:normalize=0[amixed];` +
              `[amixed]aresample=48000:async=1000,asetrate=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[audio_out];`;
          } else {
            // For single stream, apply sync correction
            filterComplexString = audioMixString + `[a0]aresample=48000:async=1000,asetrate=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[audio_out];`;
          }
        } else {
          // Generate silent audio if no audio producers
          filterComplexString += 'anullsrc=channel_layout=stereo:sample_rate=48000[audio_out];';
        }
        
        // Video filter for side-by-side with fps normalization
        if (videoConsumers.length === 2) {
            filterComplexString += 
                `[${firstVideoInputIndex}:v]scale=640:480,fps=24,format=yuv420p[left];` +
                `[${firstVideoInputIndex + 1}:v]scale=640:480,fps=24,format=yuv420p[right];` +
                `[left][right]hstack=inputs=2[video_out]`;
        } else if (videoConsumers.length === 1) {
            debug(`Single video case with fps normalization`);
            filterComplexString += 
                `[${firstVideoInputIndex}:v]scale=640:480,fps=24,format=yuv420p[video_out]`;
        }

        ffmpegArgs.push('-filter_complex', filterComplexString);
        ffmpegArgs.push('-map', '[audio_out]', '-map', '[video_out]');
        
        // Add encoding and HLS settings
        ffmpegArgs.push(
            // Audio encoding with enhanced parameters for better sync
            '-c:a', 'aac',
            '-b:a', '192k',           // Higher bitrate for better quality
            '-ar', '48000',           // Standard audio sample rate
            '-ac', '2',               // Stereo audio
            
            // Critical parameters for reliable audio
            '-fflags', '+genpts+discardcorrupt',  // Generate PTS if missing, discard corrupt packets
            '-avoid_negative_ts', 'make_zero',    // Handle negative timestamps
            
            // Enhanced sync options
            '-fps_mode', 'cfr',          // Constant framerate mode (modern replacement for vsync)
            '-async', '1000',            // Allow more audio timestamp adjustment
            '-shortest',                 // End encoding when shortest input stream ends
            '-max_interleave_delta', '0',  // Don't limit interleaving
            
            // Video encoding - optimized for low latency and better keyframe handling
            '-c:v', 'libx264',
            '-preset', 'veryfast',    // Good balance between quality and encoding speed
            '-tune', 'zerolatency',   // Optimize for low latency
            '-profile:v', 'main',
            '-level', '4.0',
            '-b:v', '1500k',
            '-maxrate', '1800k',
            '-bufsize', '3000k',
            '-g', '48',               // GOP size aligned with 2-second segments (24fps × 2s)
            '-keyint_min', '48',      // Match GOP size for consistency
            '-sc_threshold', '0',     // Disable scene change detection
            '-r', '24',               // 24fps for stability
            '-x264opts', 'no-scenecut:vbv-maxrate=1800:vbv-bufsize=3000:nal-hrd=cbr',  // CBR mode for better sync
            '-force_key_frames', 'expr:gte(t,n_forced*2)',
            '-max_muxing_queue_size', '9999', // Prevent muxing queue errors
            '-muxdelay', '0',         // Minimize muxing delay
            '-muxpreload', '0',       // Minimize preload delay

            //hls - optimized for continuous audio playback with proper segment cleanup
            '-f', 'hls',
            '-hls_time', '2',                // 2-second segments
            '-hls_list_size', '5',           // Keep only 5 segments in playlist
            '-hls_flags', 'delete_segments+append_list+discont_start+omit_endlist',  // Ensure segments are deleted
            '-hls_delete_threshold', '1',     // Delete segments as soon as they're not needed
            '-hls_segment_type', 'mpegts',    // Use MPEG-TS container for segments
            '-hls_allow_cache', '0',          // Disable caching to prevent stale segments
            '-start_number', '0',             // Start with segment 0
            '-hls_segment_filename', path.join(outputDir, 'segment_%d.ts'),
            path.join(outputDir, 'index.m3u8')
        );
        
        debug(`FFmpeg command: ${ffmpegArgs.join(' ')}`);

        // --- 6. Spawn FFmpeg process ---
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
            cwd: outputDir,
            detached: false,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle FFmpeg output with better error filtering
        ffmpegProcess.stdout.on('data', (data) => {
            debug(`FFmpeg stdout: ${data.toString()}`);
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            
            // Filter out common non-critical messages
            if (message.includes('dropping old packet') || 
                message.includes('Non-monotonous DTS') ||
                message.includes('PTS < DTS')) {
                // These are usually harmless timing warnings
                debug(`FFmpeg timing warning: ${message}`);
            } else if (message.includes('Invalid NAL unit') && 
                      message.includes('skipping')) {
                // H264 parsing warnings - usually harmless
                debug(`FFmpeg H264 warning: ${message}`);
            } else {
                debug(`FFmpeg stderr: ${message}`);
            }
        });

        ffmpegProcess.on('close', (code) => {
            debug(`FFmpeg process for room ${roomId} exited with code ${code}`);
            if (code !== 0) {
                console.error(`FFmpeg for room ${roomId} exited with error code ${code}. Check stderr for details.`);
            }
            // Cleanup all resources
            const hlsProcess = hlsProcesses.get(roomId);
            if (hlsProcess && hlsProcess.keyframeInterval) {
                clearInterval(hlsProcess.keyframeInterval);
            }
            hlsProcesses.delete(roomId);
            allTransports.forEach(transport => transport.close());
            allConsumers.forEach(consumer => consumer.close());
            debug(`Cleaned up resources for room ${roomId}`);
        });

        ffmpegProcess.on('error', (err) => {
            console.error(`Failed to start FFmpeg process for room ${roomId}: ${err.message}`);
            const hlsProcess = hlsProcesses.get(roomId);
            if (hlsProcess && hlsProcess.keyframeInterval) {
                clearInterval(hlsProcess.keyframeInterval);
            }
            hlsProcesses.delete(roomId);
            allTransports.forEach(transport => transport.close());
            allConsumers.forEach(consumer => consumer.close());
        });

        // --- 6. Store process info ---
        hlsProcesses.set(roomId, {
            ffmpegProcess,
            audioPlainTransport: audioTransports,
            videoPlainTransport: videoTransports,
            audioConsumers,
            videoConsumers,
            hlsOutputPath: path.join(outputDir, HLS_PLAYLIST_FILENAME),
            outputDir: outputDir
        });

        // --- 7. Wait for FFmpeg to initialize, then resume consumers sequentially ---
        setTimeout(async () => {
            try {
                // Resume consumers one by one with improved keyframe handling
                for (const consumer of allConsumers) {
                    if (consumer.kind === 'video') {
                        // Request multiple keyframes with increasing delays
                        await consumer.requestKeyFrame();
                        debug(`Initial keyframe requested for video consumer ${consumer.id}`);
                        
                        // Wait longer before resuming video consumers
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        // Request another keyframe
                        await consumer.requestKeyFrame();
                        debug(`Second keyframe requested for video consumer ${consumer.id}`);
                        
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    
                    // Resume the consumer
                    await consumer.resume();
                    debug(`Resumed consumer ${consumer.id}`);
                    
                    // Request one more keyframe after resuming video consumers
                    if (consumer.kind === 'video') {
                        await new Promise(resolve => setTimeout(resolve, 200));
                        await consumer.requestKeyFrame();
                        debug(`Post-resume keyframe requested for video consumer ${consumer.id}`);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 200)); // Increased delay between consumers
                }
                debug(`All consumers resumed for room ${roomId}`);
                
                // Set up periodic keyframe requests for video consumers
                const keyframeInterval = setInterval(() => {
                    videoConsumers.forEach(consumer => {
                        consumer.requestKeyFrame();
                        debug(`Periodic keyframe requested for video consumer ${consumer.id}`);
                    });
                }, 5000); // Request keyframes every 5 seconds
                
                // Store the interval for cleanup
                if (hlsProcesses.has(roomId)) {
                    const hlsProcess = hlsProcesses.get(roomId);
                    if (hlsProcess) {
                        hlsProcess.keyframeInterval = keyframeInterval;
                    }
                }
                
            } catch (error) {
                console.error(`Error resuming consumers for room ${roomId}:`, error);
            }
        }, 3000); // Reduced wait time from 5 to 3 seconds
        
        debug(`HLS started for room ${roomId}`);

        return {
            playlistPath: `hls/${roomId}/${HLS_PLAYLIST_FILENAME}`,
            outputDir: outputDir
        };

    } catch (error: any) {
        console.error(`Error during HLS setup for room ${roomId}: ${error.message}`);
        // Cleanup all resources on error
        allTransports.forEach(transport => transport.close());
        allConsumers.forEach(consumer => consumer.close());
        throw error;
    }
  }

  /**
   * Creates an SDP file for audio stream
   */
  private async createAudioSDP(audioConsumers: Consumer, port: number, streamIndex: number = 0) {
    if (!audioConsumers) return '';

    const sdpLines: string[] = [];
    sdpLines.push(`v=0`);
    sdpLines.push(`o=mediasoup 0 0 IN IP4 127.0.0.1`);
    sdpLines.push(`s=Audio Stream ${streamIndex + 1}`); 
    sdpLines.push(`c=IN IP4 127.0.0.1`);
    sdpLines.push(`t=0 0`);

    const baseConsumer = audioConsumers;
    const baseCodec = baseConsumer.rtpParameters.codecs[0];
    const payloadType = baseCodec.payloadType;
    const clockRate = baseCodec.clockRate;
    const channels = baseCodec.channels || 2;

    // Media description
    sdpLines.push(`m=audio ${port} RTP/AVP ${payloadType}`);

    // Handle OPUS codec specifically with improved quality parameters for better audio sync
    if (baseCodec.mimeType.toLowerCase().includes('opus')) {
        sdpLines.push(`a=rtpmap:${payloadType} opus/${clockRate}/${channels}`);
        // Enhanced OPUS parameters for better audio quality and sync
        // Use a higher minptime (10ms) for more stable audio packets, enable FEC, and use CBR for consistent bitrate
        sdpLines.push(`a=fmtp:${payloadType} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxplaybackrate=48000;cbr=1`);
    } else {
        const codecMime = baseCodec.mimeType.split('/')[1];
        sdpLines.push(`a=rtpmap:${payloadType} ${codecMime}/${clockRate}${channels > 1 ? `/${channels}` : ''}`);
    }

    // RTCP and direction
    sdpLines.push(`a=rtcp:${port + 1} IN IP4 127.0.0.1`);
    sdpLines.push(`a=sendonly`);

    // Add control attributes for better synchronization
    sdpLines.push(`a=control:streamid=${streamIndex}`);
    sdpLines.push(`a=ts-refclk:local`);

    // Add ptime for consistent packet timing - increased for stability
    sdpLines.push(`a=ptime:20`);

    // Add receiver buffer size hint - increased for better buffering
    sdpLines.push(`a=x-receivebuffer:4096`);

    return sdpLines.join('\n') + '\n';
  }

  /**
   * Creates an SDP file for video stream
   */
  private async createVideoSDP(videoConsumer: Consumer, port: number, streamIndex: number = 0) {
    const sdpLines: string[] = [];
    sdpLines.push(`v=0`);
    sdpLines.push(`o=mediasoup 0 0 IN IP4 127.0.0.1`);
    sdpLines.push(`s=Video Stream ${streamIndex + 1}`);
    sdpLines.push(`c=IN IP4 127.0.0.1`);
    sdpLines.push(`t=0 0`);

    const rtpParams = videoConsumer.rtpParameters;
    const codec = rtpParams.codecs[0];
    const payloadType = codec.payloadType;
    debug(`Creating Video SDP | Payload type: ${payloadType}`);
    debug(`Creating Video SDP | Codec: ${JSON.stringify(codec)}`);
    debug(`Creating Video SDP | RTP parameters: ${JSON.stringify(rtpParams)}`);

    // Media description
    sdpLines.push(`m=video ${port} RTP/AVP ${payloadType}`);

    // Handle H264 codec with proper parameters
    if (codec.mimeType.toLowerCase().includes('h264')) {
        sdpLines.push(`a=rtpmap:${payloadType} H264/90000`);

        let fmtpParams: string[] = [];

        if (codec.parameters) {
            const profileLevelId = codec.parameters['profile-level-id'] || '42e01e';
            fmtpParams.push(`profile-level-id=${profileLevelId}`);

            const packetizationMode = codec.parameters['packetization-mode'] || '1';
            fmtpParams.push(`packetization-mode=${packetizationMode}`);

            if (codec.parameters['level-asymmetry-allowed']) {
                fmtpParams.push(`level-asymmetry-allowed=${codec.parameters['level-asymmetry-allowed']}`);
            }
        } else {
            fmtpParams.push('profile-level-id=42e01e');
            fmtpParams.push('packetization-mode=1');
        }

        sdpLines.push(`a=fmtp:${payloadType} ${fmtpParams.join(';')}`);

    } else if (codec.mimeType.toLowerCase().includes('vp8')) {
        sdpLines.push(`a=rtpmap:${payloadType} VP8/90000`);

    } else if (codec.mimeType.toLowerCase().includes('vp9')) {
        sdpLines.push(`a=rtpmap:${payloadType} VP9/90000`);
        
    }
    // RTCP and direction
    sdpLines.push(`a=rtcp:${port + 1} IN IP4 127.0.0.1`);
    sdpLines.push(`a=sendonly`);
    return sdpLines.join('\n') + '\n';
  }

async stopHLS(roomId: string) {
    debug(`Stopping HLS for room ${roomId}`);
    
    try {
      const hlsData = hlsProcesses.get(roomId);
      if (!hlsData) {
        debug(`No HLS process found for room ${roomId}`);
        return;
      }

      const { ffmpegProcess, audioPlainTransport, videoPlainTransport, audioConsumers, videoConsumers, outputDir } = hlsData;

      // Kill FFmpeg process with better error handling
      try {
        if (ffmpegProcess && !ffmpegProcess.killed) {
          debug(`Terminating FFmpeg process for room ${roomId}`);
          ffmpegProcess.kill('SIGTERM');
          
          // Give it a moment to shut down gracefully
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Force kill if still running
          if (!ffmpegProcess.killed) {
            debug(`FFmpeg process didn't terminate gracefully, force killing`);
            ffmpegProcess.kill('SIGKILL');
          }
        }
      } catch (ffmpegError) {
        debug(`Error terminating FFmpeg process: ${ffmpegError}`);
        // Continue with cleanup even if FFmpeg termination fails
      }

      // Close consumers with error handling
      debug(`Closing audio consumers for room ${roomId}`);
      if (audioConsumers && audioConsumers.length > 0) {
        for (const consumer of audioConsumers) {
          try {
            if (!consumer.closed) {
              consumer.close();
            }
          } catch (consumerError) {
            debug(`Error closing audio consumer: ${consumerError}`);
          }
        }
      }
      
      debug(`Closing video consumers for room ${roomId}`);
      if (videoConsumers && videoConsumers.length > 0) {
        for (const consumer of videoConsumers) {
          try {
            if (!consumer.closed) {
              consumer.close();
            }
          } catch (consumerError) {
            debug(`Error closing video consumer: ${consumerError}`);
          }
        }
      }
      
      // Close transports with error handling
      debug(`Closing audio transports for room ${roomId}`);
      if (audioPlainTransport && audioPlainTransport.length > 0) {
        for (const transport of audioPlainTransport) {
          try {
            if (!transport.closed) {
              transport.close();
            }
          } catch (transportError) {
            debug(`Error closing audio transport: ${transportError}`);
          }
        }
      }
      
      debug(`Closing video transports for room ${roomId}`);
      if (videoPlainTransport && videoPlainTransport.length > 0) {
        for (const transport of videoPlainTransport) {
          try {
            if (!transport.closed) {
              transport.close();
            }
          } catch (transportError) {
            debug(`Error closing video transport: ${transportError}`);
          }
        }
      }

      // Clean up HLS files with better error handling
      debug(`Cleaning up HLS files in directory: ${outputDir}`);
      try {
        if (fs.existsSync(outputDir)) {
          debug(`Removing directory: ${outputDir}`);
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
      } catch (error) {
        debug(`Error cleaning up HLS files: ${error}`);
      }
    } catch (error) {
      debug(`Error cleaning up HLS files: ${error}`);
    }
  }

  /**
   * Checks if HLS is currently running for a room
   */
  isHLSRunning(roomId: string): boolean {
    return hlsProcesses.has(roomId);
  }

  /**
   * Gets the HLS playlist path if available
   */
  getHLSPlaylistPath(roomId: string): string | null {
    const hlsProcess = hlsProcesses.get(roomId);
    if (hlsProcess) {
      return hlsProcess.hlsOutputPath;
    }
    return null;
  }
}
