
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fetch, { Response } from 'node-fetch';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Interface for client information
interface Client {
  ws: WebSocket;
  userId: string;
}

// Map to store rooms and their clients
const rooms: Map<string, Client[]> = new Map();

// WebSocket connection handler
wss.on('connection', async (ws: WebSocket) => {
  let currentRoom: string | null = null;
  let currentUserId: string | null = null;

  ws.on('message', async (data) => {
    try {
      const parsedData =JSON.parse(data.toString());
      
      switch (parsedData.type) {
        case 'join':
          // Initialize room if it doesn't exist
          if (!rooms.has(parsedData.roomId)) {
            rooms.set(parsedData.roomId, []);
          }

          // Check if room is full (max 2 users for demo)
          const roomClients = rooms.get(parsedData.roomId) || [];
          if (roomClients.length >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }

          // Add client to room
          roomClients.push({ ws, userId: parsedData.userId });
          rooms.set(parsedData.roomId, roomClients);
          currentRoom = parsedData.roomId;
          currentUserId = parsedData.userId;

          // Notify other clients in the room
          roomClients.forEach((client) => {
            if (client.userId !== parsedData.userId) {
              client.ws.send(JSON.stringify({ type: 'user-joined', userId: parsedData.userId }));
            }
          });
          break;

        case 'get-router-capabilities':
            const routerRtpCapabilities =  await fetch('http://localhost:5000/routerRTPCapabilities').then(res => res.json());
            ws.send(JSON.stringify({ type: 'router-capabilities', capabilities: routerRtpCapabilities }));
            break;

        case 'create-transport':
            const transportData = await fetch('http://localhost:5000/create-transport', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ type: 'create-transport', userId: parsedData.userId, roomId: parsedData.roomId })
            }).then(res => res.json());
            ws.send(JSON.stringify({ type: 'transport-created', data: transportData }));
            break;

        case 'connect-transport':
            console.log(`Received connect-transport for user ${parsedData.userId}`);
            const connectTransportData = await fetch('http://localhost:5000/connect-transport', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ type: 'connect-transport', userId: parsedData.userId, roomId: parsedData.roomId, transportId: parsedData.transportId, dtlsParameters: parsedData.dtlsParameters })
            }).then(res => res.json());
            ws.send(JSON.stringify({ type: 'transport-connected', data: connectTransportData }));
            break;

        case 'produce':
            const {produceTransportId, kind, rtpParameters} = parsedData;
            const produceData = await fetch('http://localhost:5000/produce', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ type: 'produce', userId: currentUserId, transportId: produceTransportId, kind, rtpParameters, roomId: currentRoom })
            }).then(res => res.json());
            
            // Send response back to the user
            ws.send(JSON.stringify({ type: 'produce-success', data: produceData }));
            
            if (currentRoom && rooms.get(currentRoom)?.length && rooms.get(currentRoom)!.length > 1) {
              try {
                  // Fetch ALL producers in the room *excluding* the current user's
                  const otherUsersProducers = await fetch('http://localhost:5000/get-producers', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ roomId: currentRoom, userId: currentUserId })
                  }).then(res => res.json());
      
                  console.log(`[Signaling] Received from Mediasoup /get-producers: ${JSON.stringify(otherUsersProducers)}`); // <-- Add for debugging
      
                  if (Array.isArray(otherUsersProducers)) {
                      for (const producerInfo of otherUsersProducers) {
                          if (producerInfo && producerInfo.producerId) {
                              ws.send(JSON.stringify({ type: 'new-producer', data: { producerId: producerInfo.producerId } }));
                              console.log(`[Signaling] Sent existing producer ${producerInfo.producerId} (from ${producerInfo.peerId || 'unknown'}) to current user ${currentUserId}.`);
                          } else {
                              console.warn(`[Signaling] Skipping incomplete producer info from /get-producers: ${JSON.stringify(producerInfo)}`);
                          }
                      }
                  } else {
                      console.error(`[Signaling] Expected an array of producers from /get-producers, but got non-array: ${JSON.stringify(otherUsersProducers)}`);
                  }
              } catch (error) {
                  console.error('[Signaling] Error fetching other users producers:', error);
              }
            }

            // Notify other users in the room about new-producer
            const currentRoomClients = rooms.get(currentRoom || '') || [];
            currentRoomClients.forEach((client) => {
                if (client.userId !== parsedData.userId) {
                    client.ws.send(JSON.stringify({ type: 'new-producer', data: produceData }));
                }
            });
            break;

        case 'start-hls':
            await fetch('http://localhost:5000/start-hls', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roomId: currentRoom })
            }).catch(err => console.error('Error starting HLS:', err));
            break;

        case 'stop-hls':
            await fetch('http://localhost:5000/stop-hls', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roomId: currentRoom })
            }).then((res) => ws.send(JSON.stringify({ type: 'hls-stopped' })))
            break;

        case 'get-producers':
          // const {roomId, userId} = parsedData;
          const producerData = await fetch('http://localhost:5000/get-producers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: currentRoom, userId: currentUserId })
          }).then(res => res.json());
          ws.send(JSON.stringify({ type: 'new-producer', data: producerData }));
          break;

        case 'consume':
            const { consumeTransportId, producerId, rtpCapabilities} = parsedData;
            const consumeData = await fetch('http://localhost:5000/consume', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({  roomId: currentRoom , userId: currentUserId, transportId: consumeTransportId, producerId, rtpCapabilities})
            }).then(res => res.json());
            ws.send(JSON.stringify({ type: 'consume-success', data: consumeData }));
            break;

        case 'resume-consumer':
            const {consumerId} = parsedData;
            const resumeConsumerData = await fetch('http://localhost:5000/resume-consumer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ consumerId, roomId: currentRoom, userId: currentUserId })
            }).then(res => res.json());
            ws.send(JSON.stringify({ type: 'resume-consumer-success', data: resumeConsumerData }));
            break;

        default:
          console.error('Unknown message type:', parsedData.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentUserId) {
      // Get current room clients
      const roomClients = rooms.get(currentRoom) || [];
      
      // Remove client from room
      const updatedClients = roomClients.filter(
        (client) => client.userId !== currentUserId
      );
      
      // Update the room with filtered clients
      rooms.set(currentRoom, updatedClients);

      // Notify remaining clients
      updatedClients.forEach((client) => {
        client.ws.send(JSON.stringify({ type: 'user-left', userId: currentUserId }));
      });

      // Clean up empty room
      if (updatedClients.length === 0) {
        rooms.delete(currentRoom);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Basic HTTP endpoint for health check
app.get('/health', (req, res) => {
  res.status(200).send('Signaling server is running');
});

// Start the server
const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Signaling server running on ws://localhost:${PORT}`);
});

// process.on('SIGINT', () => {
//     console.log('Shutting down signaling server...');
//     server.close(() => {
//         console.log('Signaling server closed');
//         process.exit(0);
//     });
// });