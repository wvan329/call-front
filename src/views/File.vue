<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC File Broadcast</h2>

    <div class="connection-status">
      WebSocket Signaling Status:
      <span :class="{'status-connected': isWsConnected, 'status-disconnected': !isWsConnected}">
        {{ isWsConnected ? 'Connected' : 'Disconnected' }}
      </span>
      (My ID: {{ mySessionId || 'Connecting...' }})
      <p>Online Peers: {{ Object.keys(peerConnections).length }}</p>
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

    <div class="message-log">
      <h3>Signaling Log</h3>
      <div v-for="(log, index) in messageLogs" :key="index" :class="['log-item', log.type]">
        <span class="log-timestamp">[{{ new Date(log.timestamp).toLocaleTimeString() }}]</span>
        <span class="log-sender">From: {{ log.from || 'System' }}</span>
        <span v-if="log.to" class="log-recipient">To: {{ log.to }}</span>
        <span class="log-content">{{ log.content }}</span>
      </div>
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
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive, computed } from 'vue';

const ws = ref(null);
const isWsConnected = ref(false);
const mySessionId = ref(''); // Our own session ID from the server

// Store multiple peer connections and their associated data channels
const peerConnections = reactive({}); // { peerId: { pc: RTCPeerConnection, dc: RTCDataChannel } }

const selectedFile = ref(null);
const sendFileProgress = ref(0);
const fileTransferError = ref('');

const messageLogs = ref([]);
const receivedFiles = reactive([]); // Use reactive for array of objects

// Temporary storage for incoming file chunks for *each file*
const incomingFileBuffers = {}; // { fileId: { metadata: {}, chunks: [], receivedSize: 0, from: '', progress: 0, index: N } }

// --- WebRTC Configuration ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, // Google's public STUN server
  ]
};

// --- File Transfer Constants ---
const CHUNK_SIZE = 16 * 1024; // 16KB, a common safe chunk size for WebRTC DataChannel

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

      // Handle system messages first
      if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        addLog('system', `My session ID is: ${mySessionId.value}`);
        return;
      }

      if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        // Find new users we are not yet connected to
        const currentPeerIds = Object.keys(peerConnections);
        const onlinePeers = parsedMessage.users.filter(id => id !== mySessionId.value);

        // Initiate connection to new peers
        onlinePeers.forEach(peerId => {
          if (!currentPeerIds.includes(peerId) && !peerConnections[peerId]) {
            addLog('system', `New peer detected: ${peerId}. Initiating WebRTC connection.`);
            createOffer(peerId); // Automatically create offer for new peers
          }
        });

        // Remove connections to peers who have left
        currentPeerIds.forEach(peerId => {
          if (!onlinePeers.includes(peerId) && peerConnections[peerId]) {
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
      } else if (parsedMessage.type === 'user-left') { // Also handle user-left to clean up specific peerConnections
        addLog('system', `Peer disconnected: ${fromId}`);
        closePeerConnection(fromId);
      } else {
        addLog('received', `Signaling: ${JSON.stringify(parsedMessage)}`, fromId, parsedMessage.to);
      }
    } catch (e) {
      addLog('error', `Error processing WS message: ${message}. Error: ${e.message}`);
    }
  };

  ws.value.onclose = () => {
    isWsConnected.value = false;
    addLog('system', 'WebSocket Signaling Disconnected. Attempting to reconnect in 5 seconds...');
    // Clear all peer connections when WS disconnects
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
  if (peerConnections[targetPeerId]) {
    addLog('system', `Peer connection already exists for ${targetPeerId}. Reusing.`);
    return peerConnections[targetPeerId].pc;
  }

  addLog('system', `Creating RTCPeerConnection for ${targetPeerId}`);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetPeerId] = { pc: pc, dc: null };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      addLog('system', `Sending ICE Candidate to ${targetPeerId}`);
      ws.value.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        to: targetPeerId
      }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    addLog('system', `[${targetPeerId}] ICE Connection State: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
      addLog('error', `[${targetPeerId}] ICE Connection Failed/Disconnected/Closed. Closing peer connection.`);
      closePeerConnection(targetPeerId); // Clean up
    }
  };

  pc.ondatachannel = (event) => {
    addLog('system', `[${targetPeerId}] Received DataChannel from peer: ${event.channel.label}`);
    peerConnections[targetPeerId].dc = event.channel;
    setupDataChannelListeners(event.channel, targetPeerId);
  };

  if (isOfferer) {
    // Only the offerer creates the data channel explicitly
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
    // Clear any previous error messages related to DC state
    fileTransferError.value = '';
  };

  channel.onclose = () => {
    addLog('system', `[${peerId}] DataChannel closed: ${channel.label}`);
    if (peerConnections[peerId]) {
        peerConnections[peerId].dc = null; // Clear DC reference
    }
    // sendFileProgress.value = 0; // Don't reset global progress here
  };

  channel.onerror = (error) => {
    addLog('error', `[${peerId}] DataChannel Error: ${error.message || error}`);
    // fileTransferError.value = `Data channel error with ${peerId}: ${error.message || 'Unknown error'}`; // Too verbose for each DC
  };

  channel.onmessage = async (event) => {
    const receivedData = event.data;

    try {
      if (typeof receivedData === 'string') {
        const parsedData = JSON.parse(receivedData);
        if (parsedData.type === 'file-metadata-signal') {
          const { fileId, fileName, fileType, fileSize, from } = parsedData;
          addLog('received', `Received file metadata for ${fileName} (ID: ${fileId}) from ${from}`);
          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: [],
            receivedSize: 0,
            from: from,
            progress: 0,
            // Assign a unique index for reactive array updates
            index: receivedFiles.length,
          };
          // Add a placeholder to receivedFiles immediately for UI update
          receivedFiles.push(incomingFileBuffers[fileId]);
        } else if (parsedData.type === 'file-transfer-complete-signal') {
          const { fileId, fileName, from } = parsedData;
          addLog('received', `File transfer complete signal for ${fileName} (ID: ${fileId}) from ${from}`);
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
          addLog('error', `Received file chunk for unknown file ID: ${fileId}. Metadata might be missing.`);
          return;
        }

        const fileBuffer = incomingFileBuffers[fileId];
        fileBuffer.chunks[chunkIndex] = chunkData;
        fileBuffer.receivedSize += chunkData.byteLength;
        fileBuffer.progress = (fileBuffer.receivedSize / fileBuffer.metadata.fileSize) * 100;

        // Update the reactive receivedFiles array for progress display
        const reactiveFileItem = receivedFiles.find(item => item.index === fileBuffer.index);
        if (reactiveFileItem) {
            reactiveFileItem.progress = fileBuffer.progress;
        }

        if (isLastChunk) {
          addLog('received', `Last chunk received for ${fileBuffer.metadata.fileName} (ID: ${fileId}). Reassembling...`);
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          if (reactiveFileItem) {
              reactiveFileItem.url = url;
              reactiveFileItem.progress = 100;
          }

          delete incomingFileBuffers[fileId];
          addLog('system', `File reassembled and ready for download: ${fileBuffer.metadata.fileName}`);
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
  const pc = createPeerConnection(targetPeerId, true); // True means this client is the offerer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingMessage('offer', { sdp: offer }, targetPeerId);
    addLog('sent', `Sent WebRTC Offer to ${targetPeerId}`);
  } catch (error) {
    addLog('error', `Error creating offer for ${targetPeerId}: ${error.message}`);
  }
};

const handleOffer = async (sdp, fromId) => {
  const pc = createPeerConnection(fromId, false); // False means this client is the answerer
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
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
    addLog('error', `Error adding ICE candidate from ${fromId}: ${error.message}`);
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
  const fileId = `${mySessionId.value}-${Date.now()}-${file.name}`; // Unique ID for this file transfer

  // 1. Send file metadata over ALL open data channels (as a JSON string)
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
      addLog('sent', `Sent file metadata to peer (${dc.label}) for ${file.name} (ID: ${fileId})`);
    } catch (e) {
      addLog('error', `Failed to send metadata via data channel: ${e.message}`);
    }
  });


  // 2. Send file chunks as ArrayBuffer over ALL open data channels
  let offset = 0;
  sendFileProgress.value = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    const chunk = e.target.result; // This is an ArrayBuffer
    const header = new Uint8Array(1 + 4 + 1 + new TextEncoder().encode(fileId).byteLength); // fileIdLen (1 byte) + fileId + chunkIndex (4 bytes) + isLastChunk (1 byte)
    let headerOffset = 0;

    // Encode fileId
    const fileIdBytes = new TextEncoder().encode(fileId);
    header[headerOffset++] = fileIdBytes.byteLength;
    header.set(fileIdBytes, headerOffset);
    headerOffset += fileIdBytes.byteLength;

    // Encode chunkIndex
    const chunkIndex = Math.floor(offset / CHUNK_SIZE);
    new DataView(header.buffer).setUint32(headerOffset, chunkIndex, true);
    headerOffset += 4;

    // Encode isLastChunk
    const isLastChunk = (offset + chunk.byteLength) >= file.size;
    header[headerOffset++] = isLastChunk ? 1 : 0;

    // Concatenate header and chunk data
    const combinedBuffer = new Uint8Array(header.byteLength + chunk.byteLength);
    combinedBuffer.set(header, 0);
    combinedBuffer.set(new Uint8Array(chunk), header.byteLength);

    activeDataChannels.forEach(dc => {
        try {
            dc.send(combinedBuffer.buffer); // Send ArrayBuffer!
        } catch (e) {
            addLog('error', `Failed to send file chunk via data channel: ${e.message}`);
        }
    });

    offset += chunk.byteLength;
    sendFileProgress.value = (offset / file.size) * 100;

    if (offset < file.size) {
      readNextChunk();
    } else {
      addLog('sent', `Finished sending all chunks for ${file.name} to all active peers.`);
      // Send a final completion signal over ALL open data channels
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
              addLog('error', `Failed to send completion signal via data channel: ${e.message}`);
          }
      });

      selectedFile.value = null; // Clear selected file
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

  readNextChunk(); // Start reading the first chunk
};


onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  if (ws.value) {
    ws.value.close();
  }
  // Close all active peer connections
  Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
});
</script>

<style scoped>
/* Your existing CSS styles */
.webrtc-file-transfer-container {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 20px auto;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  background-color: #f9f9f9;
}

h2, h3 {
  color: #333;
  margin-bottom: 15px;
  border-bottom: 1px solid #eee;
  padding-bottom: 5px;
}

.connection-status, .peer-selection-section {
  margin-bottom: 20px;
  padding: 10px;
  background-color: #eef;
  border-radius: 4px;
  border: 1px solid #dde;
}

.status-connected {
  color: green;
  font-weight: bold;
}

.status-disconnected {
  color: red;
  font-weight: bold;
}

.peer-select, .file-transfer-section input[type="file"],
.file-transfer-section button {
  margin-right: 10px;
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.peer-select {
    min-width: 200px;
}

.peer-selection-section button, .file-transfer-section button {
  background-color: #007bff;
  color: white;
  border: none;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

.peer-selection-section button:disabled, .file-transfer-section button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.peer-selection-section button:hover:enabled, .file-transfer-section button:hover:enabled {
  background-color: #0056b3;
}

.file-transfer-section {
    margin-top: 20px;
    padding: 15px;
    background-color: #fff;
    border: 1px solid #eee;
    border-radius: 4px;
}

.file-transfer-section p {
    margin-top: 10px;
    color: #555;
}

.progress-bar-container {
  width: 100%;
  background-color: #e0e0e0;
  border-radius: 5px;
  margin-top: 10px;
  height: 20px;
  position: relative;
}

.progress-bar {
  height: 100%;
  background-color: #4CAF50;
  border-radius: 5px;
  text-align: center;
  color: white;
  transition: width 0.1s ease-out; /* Smooth progress update */
}

.progress-bar-container span {
    position: absolute;
    width: 100%;
    text-align: center;
    line-height: 20px;
    color: #333;
    font-size: 0.9em;
    font-weight: bold;
}


.message-log {
  margin-top: 20px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 15px;
  max-height: 300px;
  overflow-y: auto;
}

.log-item {
  padding: 5px 0;
  border-bottom: 1px dotted #eee;
  font-size: 0.9em;
  color: #666;
  text-align: left;
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

.received-files-section {
  margin-top: 20px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 15px;
}

.received-files-section ul {
  list-style: none;
  padding: 0;
}

.received-file-item {
  padding: 10px 0;
  border-bottom: 1px dotted #eee;
  text-align: left;
}

.received-file-item:last-child {
  border-bottom: none;
}

.file-info {
  margin-right: 15px;
  color: #333;
}

.download-link {
  display: inline-block;
  padding: 5px 10px;
  background-color: #6c757d;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  transition: background-color 0.3s ease;
}

.download-link:hover {
  background-color: #5a6268;
}

.error-message {
  color: red;
  margin-top: 10px;
}
</style>