# WebRTC to HLS Streaming App
This app demonstrates a WebRTC-based peer connection system that streams media between users and broadcasts the interaction using HLS playback.

## Video demo

https://github.com/user-attachments/assets/57ef9ca6-5422-4751-8b41-29333f722783



## 🧩 Tech Stack

- **Frontend**: Next.js (located in `call-stream/`)
- **Backend 1**: Signaling server (WebSocket-based) in `signaling-server/`
- **Backend 2**: MediaSFU using **mediasoup** in `mediasoup-server/` with **FFmpeg** for HLS streaming

---

## 📦 Project Structure
```
|-- .call-stream/ # Frontend (Next.js)
|-- .signaling-server/ # WebSocket signaling server
|-- .mediasoup-server/ # Media SFU with FFmpeg for HLS
```

## ⚙️ Setup Instructions

> ⚠️ Make sure **FFmpeg** is installed and added to your system's PATH before starting the mediasoup server.

### 1. Clone the Repository

```bash
git clone https://github.com/prajyot7070/webrtc-hls.git
cd webrtc-hls
```

### 2. Install Dependencies & Run
Frontend
```bash
cd call-stream
npm install
npm run dev
```
Frontend runs on port 3000

Signaling Server
```bash 
cd signaling-server
npm install
npm run dev
```
Signaling server runs on port 4000

Mediasoup Server
```bash
cd mediasoup-server
npm install
npm run dev
```
Mediasoup server runs on port 5000

## 🧪 Usage
- Navigate to http://localhost:3000/stream in two different tabs or devices for User 1 and User 2. Their cameras and mics will connect via WebRTC.
- Visit http://localhost:3000/watch as a third user to watch the live HLS stream of their conversation.
