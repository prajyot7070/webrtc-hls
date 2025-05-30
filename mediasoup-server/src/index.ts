import express from 'express';
import * as mediasoup from 'mediasoup';
import { RTCManager } from "../src/RTCManager";
import cors from 'cors';

// Add a debug logger utility
const debug = (message: string, ...args: any[]) => {
  console.log(`[INDEX] ${new Date().toISOString()} - ${message}`, ...args);
};

debug('Starting application');

const app = express();
app.use(express.json());
app.use(cors());

debug('Server created');

app.use('/hls', express.static('hls'));

async function startSFU() {
  debug('Starting SFU...');
  try {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info','ice','dtls','rtp','srtp','rtcp'],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });
    debug('SFU worker created');

    const rtcManager = new RTCManager(worker);
    debug('RTCManager instance created');

    //api endpoints
    app.post('/create-transport', async (req, res) => {
      try {
        const { roomId, userId } = req.body;
        debug(`Creating transports | userId : ${userId}`);
        const result = await rtcManager.createTransport(roomId, userId);
        debug(`Transport created for user ${userId} in room ${roomId}`);
        
        res.json(result);
      } catch (err) {
        debug('Error creating transport:', err);
        res.status(500).json({error: err});
      }
    });

  app.post('/connect-transport', async (req, res) => {
    try {
      const { roomId, userId, transportId, dtlsParameters }  = req.body;
      debug(`Connecting transport: ${transportId} for user ${userId} in room ${roomId}`);
      await rtcManager.connectTransport(roomId, userId, transportId, dtlsParameters);
      debug(`Transport ${transportId} connected successfully`);
      res.status(200).json({message: "Transport connected successfully"});
    } catch (error) {
      debug('Error connecting transport:', error);
      res.status(500).json({message: "Internal server error while connecting transport"});
    }
  });

  app.post('/produce', async (req, res) => {
    try {
      const { roomId, userId, transportId, kind, rtpParameters } = req.body;
      debug(`Producing media | userId: ${userId}, kind: ${kind}, transportId: ${transportId}`);
      const result = await rtcManager.produce(roomId, userId, transportId, kind, rtpParameters);
      debug(`Media produced successfully | producerId: ${result.producerId}`);
      res.json(result);
    } catch (error) {
      debug('Error producing media:', error);
      res.status(500).json({message: `Internal server error while calling rtcManager.produce() \n${error}`});
    }
  });

  app.post('/consume', async (req, res) => {
    try {
      const {roomId, userId, transportId, producerId, rtpCapabilities} = req.body;
      debug(`Consuming media | roomId: ${roomId}, userId: ${userId}, producerId: ${producerId}, transportId: ${transportId}`);
      const result = await rtcManager.consume(roomId, userId, transportId, producerId, rtpCapabilities);
      debug(`Media consumed successfully | consumerId: ${result.consumerId}`);
      res.json(result);
    } catch (error) {
      debug('Error consuming media:', error);
      res.status(500).json({message: `Internal server error while consuming media \n${error}`});
    }
  });

  app.post('/get-producers', async (req, res) => {
    try {
      const {userId, roomId} = req.body;
      debug(`Getting producers for user ${userId} in room ${roomId}`);
      const result = await rtcManager.getProducers(roomId, userId);
      debug(`Producers retrieved successfully | producers: ${JSON.stringify(result)}`);
      res.json(result);
    } catch (error) {
      debug('Error getting producers:', error);
      res.status(500).json({message: `Internal server error while getting producers \n${error}`});
    }
  });

  app.post('/resume-consumer', async (req, res) => {
    try {
      const {roomId, userId, consumerId} = req.body;
      debug(`Resuming consumer ${consumerId} for user ${userId} in room ${roomId}`);
      await rtcManager.resumeConsumer(roomId, userId, consumerId);
      debug(`Consumer ${consumerId} resumed successfully`);
      res.status(200).json({message: "Consumer resumed successfully"});
    } catch (error) {
      debug('Error resuming consumer:', error);
      res.status(500).json({message: "Internal server error while resuming consumer"});
    }
  });

  app.post('/start-hls', async (req, res) => {
    try {
      const {roomId} = req.body;
      debug(`Starting HLS for room ${roomId}`);
      await rtcManager.startHLS(roomId);
      debug(`HLS started successfully for room ${roomId}`);
      res.status(200).json({message: "HLS started successfully"});
    } catch (error) {
      debug('Error starting HLS:', error);
      res.status(500).json({message: "Internal server error while starting HLS"});
    }
  });

  app.post('/stop-hls', async (req, res) => {
    try {
      const {roomId} = req.body;
      debug(`Stopping HLS for room ${roomId}`);
      await rtcManager.stopHLS(roomId);
      debug(`HLS stopped successfully for room ${roomId}`);
      res.status(200).json({message: "HLS stopped successfully"});
    } catch (error) {
      debug('Error stopping HLS:', error);
      res.status(500).json({message: "Internal server error while stopping HLS"});
    }
  });

  app.get('/routerRTPCapabilities', async(req, res) => {
    debug('Getting router RTP capabilities');
    const data = await rtcManager.getRtpCapabilities();
    debug(`Router RTP capabilities retrieved`);
    res.json(data);
  });

  const port = 5000;
  app.listen(port, '0.0.0.0',() => {
    debug(`SFU server listening on port ${port}`);
  });
  } catch (error) {
    debug('Error starting SFU:', error);
    process.exit(1);
  }
}

startSFU();
