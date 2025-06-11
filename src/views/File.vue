<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC File Broadcast</h2>

    <div class="connection-info">
      <p>My ID: <span class="my-id">{{ mySessionId || 'Connecting...' }}</span></p>
      <p>Connected Peers: <span class="connected-peers-count">{{ Object.keys(peerConnections).length }}</span></p>
      <p>Signaling Server:
        <span :class="{'status-connected': isWsConnected, 'status-disconnected': !isWsConnected}">
          {{ isWsConnected ? 'Connected' : 'Disconnected' }}
        </span>
      </p>
    </div>

    <div class="file-transfer-section">
      <h3>Broadcast File</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFileBroadcast" :disabled="!selectedFile || !canBroadcastFile">
        Broadcast File
      </button>
      <p v-if="selectedFile">Selected: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
      <div v-if="sendFileProgress > 0 && sendFileProgress < 100" class="progress-bar-container">
        <div class="progress-bar" :style="{ width: sendFileProgress + '%' }"></div>
        <span>{{ sendFileProgress.toFixed(1) }}%</span>
      </div>
      <p v-if="fileTransferError" class="error-message">{{ fileTransferError }}</p>
    </div>

    <div class="received-files-section">
      <h3>Received Files</h3>
      <ul v-if="receivedFiles.length > 0">
        <li v-for="(file, index) in receivedFiles" :key="index" class="received-file-item">
          <p>
            <span class="file-info">From: {{ file.from }} - {{ file.fileName }} ({{ formatBytes(file.fileSize) }})</span>
            <a :href="file.url" :download="file.fileName" class="download-link">Download</a>
            <div v-if="file.progress < 100" class="progress-bar-container">
              <div class="progress-bar" :style="{ width: file.progress + '%' }"></div>
              <span>{{ file.progress.toFixed(1) }}%</span>
            </div>
          </p>
        </li>
      </ul>
      <p v-else>No files received yet.</p>
    </div>

    <div class="message-log">
      <h3>Event Log (for debugging)</h3>
      <div v-for="(log, index) in messageLogs" :key="index" :class="['log-item', log.type]">
        <span class="log-timestamp">[{{ new Date(log.timestamp).toLocaleTimeString() }}]</span>
        <span v-if="log.from" class="log-sender">From: {{ log.from }}</span>
        <span v-if="log.to" class="log-recipient">To: {{ log.to }}</span>
        <span class="log-content">{{ log.content }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive, computed } from 'vue';

const ws = ref(null);
const isWsConnected = ref(false);
const mySessionId = ref('');

// Store multiple peer connections and their associated data channels
const peerConnections = reactive({}); // { peerId: { pc: RTCPeerConnection, dc: RTCDataChannel } }

const selectedFile = ref(null);
const sendFileProgress = ref(0);
const fileTransferError = ref('');

const messageLogs = ref([]);
const receivedFiles = reactive([]);

// Temporary storage for incoming file chunks for *each file*
const incomingFileBuffers = {}; // { fileId: { metadata: {}, chunks: [], receivedSize: 0, from: '', progress: 0, index: N } }

// --- WebRTC Configuration ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
};

// --- File Transfer Constants ---
const CHUNK_SIZE = 16 * 1024;

const wsUrl = 'ws://59.110.35.198/wgk/ws'; // Your WebSocket signaling server URL

// Computed property to check if we can broadcast (at least one data channel is open)
const canBroadcastFile = computed(() => {
  return Object.values(peerConnections).some(pcInfo => pcInfo.dc && pcInfo.dc.readyState === 'open');
});

// --- Utility Functions ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const addLog = (type, content, from = null, to = null) => {
  // Filter out excessive ICE candidate logs unless debugging
  if (type === 'system' && (content.includes('Sending ICE Candidate') || content.includes('Received ICE Candidate'))) {
    // return; // Uncomment to hide ICE candidate logs
  }
  if (type === 'received' && content.includes('Received chunk')) {
    // return; // Uncomment to hide received chunk logs
  }

  messageLogs.value.push({
    type,
    content,
    from,
    to,
    timestamp: Date.now(),
  });
  if (messageLogs.value.length > 200) {
    messageLogs.value.splice(0, messageLogs.value.length - 100);
  }
};

// --- WebSocket Signaling Logic ---
const connectWebSocket = () => {
  ws.value = new WebSocket(wsUrl);

  ws.value.onopen = () => {
    isWsConnected.value = true;
    addLog('system', 'WebSocket Signaling Connected.');
    setInterval(() => {
      if (ws.value && ws.value.readyState === WebSocket.OPEN) {
        ws.value.send('ping');
      }
    }, 25000);
  };

  ws.value.onmessage = async (event) => {
    const message = event.data;

    if (message === 'pong') {
      return;
    }

    try {
      const parsedMessage = JSON.parse(message);

      // Handle system messages first (from server, no 'from' field)
      if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        addLog('system', `My session ID is: ${mySessionId.value}`);
        return; // Handled, return
      }

      if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        const onlinePeers = parsedMessage.users.filter(id => id !== mySessionId.value);
        const currentConnectedPeers = Object.keys(peerConnections);

        // Initiate connection to new peers based on Session ID comparison
        onlinePeers.forEach(peerId => {
          if (!currentConnectedPeers.includes(peerId) && !peerConnections[peerId]) {
            // Only create offer if mySessionId is lexicographically smaller than peerId
            // This prevents simultaneous offers (glare)
            if (mySessionId.value < peerId) {
                addLog('system', `New peer detected (${peerId}). My ID is smaller, creating offer.`);
                createOffer(peerId);
            } else {
                addLog('system', `New peer detected (${peerId}). My ID is larger, waiting for offer.`);
            }
          }
        });

        // Close connections to peers who have left
        currentConnectedPeers.forEach(peerId => {
          if (!onlinePeers.includes(peerId)) {
            addLog('system', `Peer ${peerId} is no longer in user list. Closing connection.`);
            closePeerConnection(peerId);
          }
        });
        return; // Handled user-list
      }

      // If it's not a system message, it must be a signaling message from another peer
      const fromId = parsedMessage.from;
      if (!fromId) {
        addLog('error', `Received message with no 'from' field: ${message}`);
        return;
      }

      // --- Handle WebRTC Signaling Messages ---
      if (parsedMessage.type === 'offer') {
        addLog('received', `Received WebRTC Offer from ${fromId}`, fromId);
        await handleOffer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'answer') {
        addLog('received', `Received WebRTC Answer from ${fromId}`, fromId);
        await handleAnswer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'candidate') {
        addLog('received', `Received ICE Candidate from ${fromId}`, fromId);
        await handleCandidate(parsedMessage.candidate, fromId);
      } else if (parsedMessage.type === 'user-left') {
        addLog('system', `Peer disconnected: ${fromId}`);
        closePeerConnection(fromId);
      } else {
        // Fallback for any other unexpected messages from peers
        addLog('received', `Unexpected signaling from ${fromId}: ${JSON.stringify(parsedMessage)}`, fromId, parsedMessage.to);
      }
    } catch (e) {
      addLog('error', `Error processing WS message: ${message}. Error: ${e.message}`);
    }
  };

  ws.value.onclose = () => {
    isWsConnected.value = false;
    addLog('system', 'WebSocket Signaling Disconnected. Attempting to reconnect in 5 seconds...');
    Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    addLog('error', `WebSocket Error: ${error.message || error}`);
    ws.value.close();
  };
};

// --- WebRTC Peer Connection Logic ---
const createPeerConnection = (targetPeerId, isOfferer = true) => {
  // If a connection already exists, and it's active, reuse it.
  // If it's closed/failed, we recreate it.
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
      peerConnections[targetPeerId].pc.connectionState !== 'closed' &&
      peerConnections[targetPeerId].pc.iceConnectionState !== 'failed' &&
      peerConnections[targetPeerId].pc.iceConnectionState !== 'disconnected') {
    addLog('system', `Peer connection to ${targetPeerId} already exists and is active. Reusing.`);
    return peerConnections[targetPeerId].pc;
  }

  addLog('system', `Creating RTCPeerConnection for ${targetPeerId}`);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetPeerId] = { pc: pc, dc: null };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      addLog('system', `[${targetPeerId}] Sending ICE Candidate`);
      ws.value.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        to: targetPeerId
      }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    addLog('system', `[${targetPeerId}] ICE Connection State: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      addLog('error', `[${targetPeerId}] ICE Connection Failed/Disconnected. Closing peer connection.`);
      closePeerConnection(targetPeerId); // Clean up
    }
  };

  pc.onconnectionstatechange = () => {
      addLog('system', `[${targetPeerId}] RTCPeerConnection State: ${pc.connectionState}`);
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          addLog('error', `[${targetPeerId}] PeerConnection state changed to ${pc.connectionState}. Closing.`);
          closePeerConnection(targetPeerId);
      }
  };


  pc.ondatachannel = (event) => {
    addLog('system', `[${targetPeerId}] Received DataChannel from peer: ${event.channel.label}`);
    peerConnections[targetPeerId].dc = event.channel;
    setupDataChannelListeners(event.channel, targetPeerId);
  };

  if (isOfferer) {
    const dc = pc.createDataChannel("file-transfer-channel", {
      ordered: true,
      maxRetransmits: 0
    });
    addLog('system', `[${targetPeerId}] Created DataChannel for file transfer.`);
    peerConnections[targetPeerId].dc = dc;
    setupDataChannelListeners(dc, targetPeerId);
  }
  return pc;
};

const setupDataChannelListeners = (channel, peerId) => {
  channel.onopen = () => {
    addLog('system', `[${peerId}] DataChannel opened: ${channel.label}`);
    fileTransferError.value = ''; // Clear any previous error messages related to DC state
  };

  channel.onclose = () => {
    addLog('system', `[${peerId}] DataChannel closed: ${channel.label}`);
    if (peerConnections[peerId]) {
        peerConnections[peerId].dc = null;
    }
  };

  channel.onerror = (error) => {
    addLog('error', `[${peerId}] DataChannel Error: ${error.message || error}`);
  };

  channel.onmessage = async (event) => {
    const receivedData = event.data;

    try {
      if (typeof receivedData === 'string') {
        const parsedData = JSON.parse(receivedData);
        if (parsedData.type === 'file-metadata-signal') {
          const { fileId, fileName, fileType, fileSize, from } = parsedData;
          addLog('received', `[${from}] Received file metadata for ${fileName}`);
          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: [],
            receivedSize: 0,
            from: from,
            progress: 0,
            index: receivedFiles.length, // Assign unique index for reactive array updates
          };
          receivedFiles.push(incomingFileBuffers[fileId]); // Add a placeholder to receivedFiles immediately
        } else if (parsedData.type === 'file-transfer-complete-signal') {
          const { fileId, fileName, from } = parsedData;
          addLog('received', `[${from}] File transfer complete signal for ${fileName}`);
        } else {
          addLog('received', `[${peerId}] DataChannel String: ${receivedData}`);
        }
      } else if (receivedData instanceof ArrayBuffer) {
        const view = new DataView(receivedData);
        const fileIdLen = view.getUint8(0);
        const fileId = new TextDecoder().decode(receivedData.slice(1, 1 + fileIdLen));
        const chunkIndex = view.getUint32(1 + fileIdLen, true);
        const isLastChunk = view.getUint8(1 + fileIdLen + 4) === 1;
        const chunkData = receivedData.slice(1 + fileIdLen + 4 + 1);

        if (!incomingFileBuffers[fileId]) {
          addLog('error', `Received chunk for unknown file ID: ${fileId}. Metadata might be missing.`);
          return;
        }

        const fileBuffer = incomingFileBuffers[fileId];
        fileBuffer.chunks[chunkIndex] = chunkData;
        fileBuffer.receivedSize += chunkData.byteLength;
        fileBuffer.progress = (fileBuffer.receivedSize / fileBuffer.metadata.fileSize) * 100;

        const reactiveFileItem = receivedFiles.find(item => item.index === fileBuffer.index);
        if (reactiveFileItem) {
            reactiveFileItem.progress = fileBuffer.progress;
        }

        if (isLastChunk) {
          addLog('received', `[${fileBuffer.from}] Last chunk received for ${fileBuffer.metadata.fileName}. Reassembling...`);
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          if (reactiveFileItem) {
              reactiveFileItem.url = url;
              reactiveFileItem.progress = 100;
          }

          delete incomingFileBuffers[fileId];
          addLog('system', `[${fileBuffer.from}] File reassembled and ready for download: ${fileBuffer.metadata.fileName}`);
        }
      }
    } catch (e) {
      addLog('error', `Error processing DataChannel message from ${peerId}: ${e.message}`);
    }
  };
};

const concatenateArrayBuffers = (buffers) => {
    let totalLength = 0;
    for (const buffer of buffers) {
        if (buffer) {
            totalLength += buffer.byteLength;
        }
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of buffers) {
        if (buffer) {
            result.set(new Uint8Array(buffer), offset);
            offset += buffer.byteLength;
        }
    }
    return result.buffer;
};

const closePeerConnection = (peerId) => {
  if (peerConnections[peerId]) {
    if (peerConnections[peerId].dc) {
      peerConnections[peerId].dc.close();
      peerConnections[peerId].dc = null;
    }
    if (peerConnections[peerId].pc) {
      peerConnections[peerId].pc.close();
      peerConnections[peerId].pc = null;
    }
    delete peerConnections[peerId];
    addLog('system', `Peer connection to ${peerId} closed.`);
  }
};

// --- WebRTC Signaling Message Handlers (Send to signaling server) ---
const sendSignalingMessage = (type, payload, toId) => {
    if (ws.value && ws.value.readyState === WebSocket.OPEN && toId) {
        const message = {
            type: type,
            to: toId,
            ...payload
        };
        ws.value.send(JSON.stringify(message));
    } else {
        addLog('error', `Cannot send signaling message to ${toId}: WS not open or missing target for ${type}`);
    }
};

const createOffer = async (targetPeerId) => {
  // If we already have an active PC for this peer, don't create another offer
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
      peerConnections[targetPeerId].pc.connectionState !== 'closed' &&
      peerConnections[targetPeerId].pc.iceConnectionState !== 'failed') {
      // If it's already in have-local-offer state, means we already sent an offer
      if (peerConnections[targetPeerId].pc.localDescription && peerConnections[targetPeerId].pc.localDescription.type === 'offer') {
          addLog('warn', `[${targetPeerId}] Already in have-local-offer state, not creating new offer.`);
          return;
      }
  }

  const pc = createPeerConnection(targetPeerId, true); // True means this client is the offerer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer); // Set local description before sending
    sendSignalingMessage('offer', { sdp: offer }, targetPeerId);
    addLog('sent', `Sent WebRTC Offer to ${targetPeerId}`);
  } catch (error) {
    addLog('error', `Error creating offer for ${targetPeerId}: ${error.message}`);
  }
};

const handleOffer = async (sdp, fromId) => {
  const pc = createPeerConnection(fromId, false); // False means this client is the answerer
  try {
    // Handle glare: if we've already created an offer, compare.
    // For simplicity here, if current state is have-local-offer, we might ignore or re-evaluate.
    // A more robust glare handling might involve comparing SDPs or waiting for connection state.
    // For now, if we have an existing offer that's not stable, we proceed.
    if (pc.signalingState === 'have-local-offer') {
        addLog('warn', `[${fromId}] Received offer while in 'have-local-offer' state. Handling as new offer.`);
        // This is where "glare" handling comes in. For now, we'll try to setRemoteDescription directly.
        // In a real app, you might re-negotiate or reject based on a tie-breaker.
        // For simplicity, we proceed, as setRemoteDescription will attempt to update state.
    } else if (pc.signalingState === 'stable') {
        // If stable and receiving an offer, it's a fresh incoming offer.
        addLog('system', `[${fromId}] Received offer in 'stable' state. Processing new offer.`);
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer); // Set local description before sending
    sendSignalingMessage('answer', { sdp: answer }, fromId);
    addLog('sent', `Sent WebRTC Answer to ${fromId}`);
  } catch (error) {
    addLog('error', `Error handling offer from ${fromId}: ${error.message}`);
  }
};

const handleAnswer = async (sdp, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    addLog('error', `No PeerConnection found for answer from ${fromId}.`);
    return;
  }
  try {
    // Ensure we are in a state that can accept an answer (e.g., have-local-offer)
    if (pcInfo.pc.signalingState !== 'have-local-offer') {
        addLog('warn', `[${fromId}] Received answer while in state ${pcInfo.pc.signalingState}. Expected 'have-local-offer'.`);
    }
    await pcInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    addLog('error', `Error handling answer from ${fromId}: ${error.message}`);
  }
};

const handleCandidate = async (candidate, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    addLog('error', `No PeerConnection found for candidate from ${fromId}.`);
    return;
  }
  try {
    await pcInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    // This error often happens if a candidate arrives when setRemoteDescription hasn't completed yet
    // or if connection is already established/closed. It's usually safe to ignore if the connection
    // eventually forms. Log for debugging but don't show as a prominent error to user.
    addLog('error', `[${fromId}] Error adding ICE candidate: ${error.message}`);
  }
};

// --- File Selection & Broadcasting Logic ---
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendFileProgress.value = 0;
  fileTransferError.value = '';
};

const sendFileBroadcast = async () => {
  const activeDataChannels = Object.values(peerConnections)
    .filter(pcInfo => pcInfo.dc && pcInfo.dc.readyState === 'open')
    .map(pcInfo => pcInfo.dc);

  if (activeDataChannels.length === 0) {
    fileTransferError.value = 'No active Data Channels to broadcast to. Please wait for peers to connect.';
    return;
  }
  if (!selectedFile.value) {
    fileTransferError.value = 'No file selected.';
    return;
  }

  const file = selectedFile.value;
  const fileId = `${mySessionId.value}-${Date.now()}-${file.name}`;

  // 1. Send file metadata over ALL open data channels
  const metadata = {
    type: 'file-metadata-signal',
    fileId: fileId,
    fileName: file.name,
    fileType: file.type || 'application/octet-stream',
    fileSize: file.size,
    from: mySessionId.value
  };
  const metadataPayload = JSON.stringify(metadata);

  activeDataChannels.forEach(dc => {
    try {
      dc.send(metadataPayload);
      addLog('sent', `[${dc.label.split('-')[0]}] Sent file metadata for ${file.name}`);
    } catch (e) {
      addLog('error', `[${dc.label.split('-')[0]}] Failed to send metadata: ${e.message}`);
    }
  });


  // 2. Send file chunks as ArrayBuffer over ALL open data channels
  let offset = 0;
  sendFileProgress.value = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    const chunk = e.target.result;
    const header = new Uint8Array(1 + 4 + 1 + new TextEncoder().encode(fileId).byteLength);
    let headerOffset = 0;

    const fileIdBytes = new TextEncoder().encode(fileId);
    header[headerOffset++] = fileIdBytes.byteLength;
    header.set(fileIdBytes, headerOffset);
    headerOffset += fileIdBytes.byteLength;

    const chunkIndex = Math.floor(offset / CHUNK_SIZE);
    new DataView(header.buffer).setUint32(headerOffset, chunkIndex, true);
    headerOffset += 4;

    const isLastChunk = (offset + chunk.byteLength) >= file.size;
    header[headerOffset++] = isLastChunk ? 1 : 0;

    const combinedBuffer = new Uint8Array(header.byteLength + chunk.byteLength);
    combinedBuffer.set(header, 0);
    combinedBuffer.set(new Uint8Array(chunk), header.byteLength);

    activeDataChannels.forEach(dc => {
        try {
            dc.send(combinedBuffer.buffer);
        } catch (e) {
            addLog('error', `[${dc.label.split('-')[0]}] Failed to send file chunk: ${e.message}`);
        }
    });

    offset += chunk.byteLength;
    sendFileProgress.value = (offset / file.size) * 100;

    if (offset < file.size) {
      readNextChunk();
    } else {
      addLog('sent', `Finished sending all chunks for ${file.name} to all active peers.`);
      const completeSignalPayload = JSON.stringify({
        type: 'file-transfer-complete-signal',
        fileId: fileId,
        fileName: file.name,
        from: mySessionId.value
      });
      activeDataChannels.forEach(dc => {
          try {
              dc.send(completeSignalPayload);
          } catch (e) {
              addLog('error', `[${dc.label.split('-')[0]}] Failed to send completion signal: ${e.message}`);
          }
      });

      selectedFile.value = null;
      if (document.querySelector('input[type="file"]')) {
        document.querySelector('input[type="file"]').value = '';
      }
    }
  };

  reader.onerror = (error) => {
    console.error('FileReader error:', error);
    fileTransferError.value = 'Error reading file: ' + error.message;
  };

  const readNextChunk = () => {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  };

  readNextChunk();
};


onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  if (ws.value) {
    ws.value.close();
  }
  Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
});
</script>

<style scoped>
/* Simplified CSS for the refined UI */
.webrtc-file-transfer-container {
  font-family: Arial, sans-serif;
  max-width: 600px; /* Make it a bit narrower */
  margin: 20px auto;
  padding: 25px; /* More padding */
  border: 1px solid #ddd;
  border-radius: 10px; /* More rounded corners */
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); /* Stronger shadow */
  background-color: #ffffff; /* White background */
}

h2 {
  text-align: center;
  color: #2c3e50;
  margin-bottom: 25px;
  font-size: 1.8em;
}

h3 {
  color: #34495e;
  margin-bottom: 15px;
  border-bottom: 1px solid #eee;
  padding-bottom: 5px;
  font-size: 1.2em;
}

.connection-info {
  background-color: #e8f5e9; /* Light green */
  border: 1px solid #a5d6a7; /* Darker green border */
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 25px;
  text-align: center;
}

.connection-info p {
  margin: 5px 0;
  font-size: 1em;
  color: #388e3c; /* Green text */
}

.my-id, .connected-peers-count {
  font-weight: bold;
  color: #1b5e20; /* Darker green */
}

.status-connected {
  color: #28a745; /* Green */
  font-weight: bold;
}

.status-disconnected {
  color: #dc3545; /* Red */
  font-weight: bold;
}

.file-transfer-section {
  background-color: #f8f9fa; /* Light grey */
  border: 1px solid #e9ecef;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 25px;
}

.file-transfer-section input[type="file"] {
  display: block; /* Stack on new line */
  width: calc(100% - 20px); /* Adjust for padding */
  padding: 10px;
  border: 1px solid #ced4da;
  border-radius: 5px;
  margin-bottom: 15px;
  box-sizing: border-box; /* Include padding in width */
}

.file-transfer-section button {
  width: 100%; /* Full width */
  padding: 12px 20px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 1em;
  transition: background-color 0.3s ease;
}

.file-transfer-section button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.file-transfer-section button:hover:enabled {
  background-color: #0056b3;
}

.file-transfer-section p {
  margin-top: 15px;
  color: #555;
  font-size: 0.95em;
}

.progress-bar-container {
  width: 100%;
  background-color: #e0e0e0;
  border-radius: 5px;
  margin-top: 15px;
  height: 25px; /* Taller progress bar */
  position: relative;
  overflow: hidden; /* Hide overflow for bar */
}

.progress-bar {
  height: 100%;
  background-color: #28a745; /* Green */
  border-radius: 5px;
  text-align: center;
  color: white;
  transition: width 0.1s ease-out;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9em;
}

.progress-bar-container span {
    position: absolute;
    width: 100%;
    text-align: center;
    line-height: 25px; /* Center text vertically */
    color: #333; /* Darker text for visibility */
    font-size: 0.9em;
    font-weight: bold;
    text-shadow: 0 0 2px rgba(255,255,255,0.7); /* Add slight text shadow */
}


.received-files-section {
  background-color: #ffffff;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 25px;
}

.received-files-section ul {
  list-style: none;
  padding: 0;
}

.received-file-item {
  padding: 12px 0;
  border-bottom: 1px dotted #e0e0e0;
  text-align: left;
}

.received-file-item:last-child {
  border-bottom: none;
}

.file-info {
  margin-right: 15px;
  color: #333;
  font-size: 0.95em;
}

.download-link {
  display: inline-block;
  padding: 6px 12px;
  background-color: #6c757d;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  transition: background-color 0.3s ease;
  font-size: 0.9em;
}

.download-link:hover {
  background-color: #5a6268;
}

.error-message {
  color: #dc3545;
  margin-top: 15px;
  font-weight: bold;
}

/* Log styles (kept for debugging, but minimized) */
.message-log {
  margin-top: 20px;
  background-color: #f0f4f7; /* Lighter background for logs */
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  padding: 15px;
  max-height: 200px; /* Smaller log height */
  overflow-y: auto;
  font-size: 0.8em; /* Smaller font for logs */
}

.message-log h3 {
    margin-bottom: 10px;
    border-bottom: 1px dotted #ccc;
    padding-bottom: 5px;
}

.log-item {
  padding: 3px 0;
  border-bottom: 1px dotted #e8e8e8;
  color: #666;
}

.log-item:last-child {
  border-bottom: none;
}

.log-timestamp {
  color: #999;
  margin-right: 5px;
}

.log-sender, .log-recipient {
  font-weight: bold;
  margin-right: 5px;
}

.log-item.system {
  color: #0056b3;
}
.log-item.sent {
  color: #28a745;
}
.log-item.received {
  color: #ffc107;
}
.log-item.error {
  color: #dc3545;
  font-weight: bold;
}
.log-item.warn {
  color: orange;
}
</style>