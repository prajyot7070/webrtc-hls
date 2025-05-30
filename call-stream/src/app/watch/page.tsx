// watch/page.tsx
'use client'; // This directive makes it a Client Component in Next.js

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Hls from 'hls.js'; // Import the hls.js library

const WatchPage: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [hlsError, setHlsError] = useState<string | null>(null);

  useEffect(() => {
    // Get the room ID from the URL query parameters
    const id = searchParams.get('roomId');
    if (id) {
      setRoomId(id);
    } else {
      // If no roomId is provided, redirect or show an error
      setHlsError('Room ID is missing in the URL. Please provide a roomId, e.g., /watch?roomId=YOUR_ROOM_ID');
      // Optionally, redirect after a delay
      // setTimeout(() => router.push('/'), 3000);
    }
  }, [searchParams, router]);

  useEffect(() => {
    if (!roomId || !videoRef.current) {
      return; // Wait until roomId is available and videoRef is set
    }

    const video = videoRef.current;
    const baseUrl = process.env.NEXT_PUBLIC_MEDIA_SERVER_URL;
    const hlsUrl = `http://localhost:5000/hls/${roomId}/index.m3u8` ; // Adjust path as needed

    console.log(`[WatchPage] Attempting to load HLS stream from: ${hlsUrl}`);

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[WatchPage] HLS Manifest Parsed. Starting playback.');
        video.play().catch(error => {
          console.error('[WatchPage] Video playback failed:', error);
          setHlsError(`Autoplay prevented or playback error: ${error.message}`);
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('[WatchPage] HLS.js error:', data);
        let errorMessage = `HLS playback error: ${data.details}`;
        if (data.fatal) {
          errorMessage += ` (Fatal error, trying to recover...)`;
          switch(data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Try to recover network errors
              console.log('[WatchPage] Trying to recover from network error...');
              hls.recoverMediaError();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[WatchPage] Trying to recover from media error...');
              hls.recoverMediaError();
              break;
            default:
              // Cannot recover
              console.log('[WatchPage] Unrecoverable HLS error. Destroying HLS instance.');
              hls.destroy();
              errorMessage = `Unrecoverable HLS error: ${data.details}. Please refresh.`;
              break;
          }
        }
        setHlsError(errorMessage);
      });

      return () => {
        // Cleanup HLS instance on component unmount
        if (hls) {
          hls.destroy();
          console.log('[WatchPage] HLS instance destroyed.');
        }
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari on macOS/iOS)
      console.log('[WatchPage] Browser supports native HLS playback.');
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(error => {
          console.error('[WatchPage] Native video playback failed:', error);
          setHlsError(`Autoplay prevented or playback error: ${error.message}`);
        });
      });
      return () => {
        // No explicit destroy needed for native playback
      };
    } else {
      setHlsError('Your browser does not support HLS playback.');
      console.error('[WatchPage] HLS is not supported in this browser.');
    }
  }, [roomId]); // Re-run effect if roomId changes

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      backgroundColor: '#121212', // Darker background
      color: '#fff',
      fontFamily: 'Arial, sans-serif'
    }}>
      <h1 style={{ marginBottom: '20px' }}>Live Stream: {roomId ? `Room "${roomId}"` : 'Loading...'}</h1>
      {hlsError && (
        <div style={{
          backgroundColor: '#ff4d4d',
          padding: '10px 20px',
          borderRadius: '5px',
          marginBottom: '20px',
          color: '#fff'
        }}>
          Error: {hlsError}
        </div>
      )}
      <div style={{
        width: '90%', // Increased width percentage
        maxWidth: '1200px', // Increased max width
        backgroundColor: '#000',
        borderRadius: '8px',
        overflow: 'hidden',
        boxShadow: '0 0 20px rgba(0, 0, 0, 0.5)' // Added shadow for depth
      }}>
        <video
          ref={videoRef}
          controls
          muted
          autoPlay
          playsInline // Important for mobile devices
          style={{ width: '100%', height: 'auto', display: 'block' }}
        >
          Your browser does not support the video tag.
        </video>
      </div>
      <p style={{ marginTop: '20px', fontSize: '0.9em', color: '#888' }}>
        Watching live stream from room "{roomId || 'N/A'}".
      </p>
    </div>
  );
};

export default WatchPage;