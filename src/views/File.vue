<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC File Transfer</h2>

    <div class="connection-status">
      WebSocket Signaling Status:
      <span :class="{'status-connected': isWsConnected, 'status-disconnected': !isWsConnected}">
        {{ isWsConnected ? 'Connected' : 'Disconnected' }}
      </span>
      (My ID: {{ mySessionId || 'Connecting...' }})
    </div>

    <div class="peer-selection-section">
      <h3>Peer Connection</h3>
      <select v-model="selectedPeerId" class="peer-select">
        <option value="">Select a peer to connect</option>
        <option v-for="peerId in availablePeers" :key="peerId" :value="peerId">
          {{ peerId }}
        </option>
      </select>
      <button @click="createOffer" :disabled="!selectedPeerId || !isWsConnected || !!peerConnection">
        Connect to Peer
      </button>
      <button @click="closePeerConnection" :disabled="!peerConnection">
        Disconnect Peer
      </button>
      <p v-if="peerConnection">
        Peer Connection Status:
        <span :class="{'status-connected': isPeerConnected, 'status-disconnected': !isPeerConnected}">
          {{ peerConnection.iceConnectionState }}
        </span>
      </p>
      <p v-if="dataChannel">
        Data Channel Status:
        <span :class="{'status-connected': dataChannel.readyState === 'open', 'status-disconnected': dataChannel.readyState !== 'open'}">
          {{ dataChannel.readyState }}
        </span>
      </p>
    </div>

    <div class="file-transfer-section" v-if="isPeerConnected && dataChannel && dataChannel.readyState === 'open'">
      <h3>Send File</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFile" :disabled="!selectedFile || !dataChannel || dataChannel.readyState !== 'open'">
        Send File
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
import { ref, onMounted, onUnmounted, reactive } from 'vue';

const ws = ref(null);
const isWsConnected = ref(false);
const mySessionId = ref(''); // Our own session ID from the server
const selectedPeerId = ref(''); // The peer we want to connect to
const availablePeers = ref([]); // List of other connected peers

const peerConnection = ref(null);
const dataChannel = ref(null);
const isPeerConnected = ref(false);

const selectedFile = ref(null);
const sendFileProgress = ref(0);
const fileTransferError = ref('');

const messageLogs = ref([]);
const receivedFiles = reactive([]); // Use reactive for array of objects

// Temporary storage for incoming file chunks
const incomingFileBuffers = {}; // { fileId: { metadata: {}, buffer: [], receivedSize: 0, from: '' } }

// --- WebRTC Configuration ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, // Google's public STUN server
    // You might add TURN servers here for more robust NAT traversal
    // { urls: 'turn:your.turn.server.com:3478', username: 'user', credential: 'password' }
  ]
};

// --- File Transfer Constants ---
const CHUNK_SIZE = 16 * 1024; // 16KB, a common safe chunk size for WebRTC DataChannel

const wsUrl = 'ws://59.110.35.198/wgk/ws'; // Your WebSocket signaling server URL

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
  // Keep log concise, maybe only last 100 messages
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
    // Periodically send ping to keep connection alive
    setInterval(() => {
      if (ws.value && ws.value.readyState === WebSocket.OPEN) {
        ws.value.send('ping');
      }
    }, 25000); // Send ping every 25 seconds
  };

ws.value.onmessage = async (event) => {
  const message = event.data;

  if (message === 'pong') {
    return;
  }

  try {
    const parsedMessage = JSON.parse(message);
    const fromId = parsedMessage.from; // 这行在这里可能会导致问题，因为它会尝试访问不存在的'from'

    // --- 正确处理自己的 session ID ---
    if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        addLog('system', `My session ID is: ${mySessionId.value}`);
        return; // 处理完后直接返回，不再向下执行，避免尝试访问 'from'
    }

    // --- 处理用户列表更新 ---
    if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        // 更新可用 peer 列表，排除自己
        const newPeers = parsedMessage.users.filter(id => id !== mySessionId.value);
        // 使用 Set 来去重并保持当前选中的 peer 不变
        const currentSelected = selectedPeerId.value;
        availablePeers.value = Array.from(new Set([...newPeers, currentSelected])).filter(Boolean); // 过滤掉空值
        addLog('system', `Updated user list. Online peers: ${newPeers.join(', ')}`);
        return; // 处理完后直接返回
    }

    // --- Update available peers list (针对其他信令消息，如 offer/answer/candidate) ---
    // 只有当消息有from字段时才处理 peer 列表更新
    if (fromId && fromId !== mySessionId.value) {
        const newPeers = new Set(availablePeers.value);
        newPeers.add(fromId);
        // 如果 fromId 是 'user-left' 消息，则在下面处理
        if (parsedMessage.type === 'user-left') {
            newPeers.delete(fromId);
            addLog('system', `Peer disconnected: ${fromId}`);
            if (selectedPeerId.value === fromId) {
                selectedPeerId.value = '';
                closePeerConnection();
            }
        }
        availablePeers.value = Array.from(newPeers);
    }


    // --- Handle WebRTC Signaling Messages ---
    if (parsedMessage.type === 'offer') {
      addLog('received', `Received WebRTC Offer from ${fromId}`, fromId); // 确保 fromId 有效
      await handleOffer(parsedMessage.sdp, fromId);
    } else if (parsedMessage.type === 'answer') {
      addLog('received', `Received WebRTC Answer from ${fromId}`, fromId);
      await handleAnswer(parsedMessage.sdp);
    } else if (parsedMessage.type === 'candidate') {
      addLog('received', `Received ICE Candidate from ${fromId}`, fromId);
      await handleCandidate(parsedMessage.candidate);
    } else if (parsedMessage.type === 'file-metadata-signal' || parsedMessage.type === 'file-transfer-complete-signal') {
        // 这些消息从 data channel 收到，不应该从 signaling WS 收到
        // 如果是调试中误发，可以记录日志但不需要特殊处理
        addLog('warn', `Unexpected file transfer signal on main WS from ${fromId}: ${parsedMessage.type}`);
    } else {
      // 通用信令消息（如旧的语音信令，如果还在用）
      addLog('received', `Signaling: ${JSON.stringify(parsedMessage)}`, fromId, parsedMessage.to);
    }
  } catch (e) {
    // 如果不是有效的 JSON，或者其他处理错误，记录下来
    addLog('error', `Error processing WS message: ${message}. Error: ${e.message}`);
  }
};

  ws.value.onclose = () => {
    isWsConnected.value = false;
    addLog('system', 'WebSocket Signaling Disconnected. Attempting to reconnect in 5 seconds...');
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    addLog('error', `WebSocket Error: ${error.message || error}`);
    ws.value.close();
  };
};

// --- WebRTC Peer Connection Logic ---
const createPeerConnection = (targetPeerId) => {
  if (peerConnection.value) {
    addLog('system', 'Existing peer connection found, closing it.');
    closePeerConnection();
  }

  addLog('system', `Creating RTCPeerConnection for ${targetPeerId}`);
  peerConnection.value = new RTCPeerConnection(RTC_CONFIG);
  isPeerConnected.value = false; // Reset status

  peerConnection.value.onicecandidate = (event) => {
    if (event.candidate) {
      addLog('system', `Sending ICE Candidate to ${targetPeerId}`);
      ws.value.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        to: targetPeerId
      }));
    }
  };

  peerConnection.value.oniceconnectionstatechange = () => {
    addLog('system', `ICE Connection State: ${peerConnection.value.iceConnectionState}`);
    isPeerConnected.value = (peerConnection.value.iceConnectionState === 'connected' || peerConnection.value.iceConnectionState === 'completed');
    if (peerConnection.value.iceConnectionState === 'failed' || peerConnection.value.iceConnectionState === 'disconnected') {
      addLog('error', `ICE Connection Failed or Disconnected. Closing peer connection.`);
      closePeerConnection();
    }
  };

  peerConnection.value.ondatachannel = (event) => {
    addLog('system', `Received DataChannel from peer: ${event.channel.label}`);
    dataChannel.value = event.channel;
    setupDataChannelListeners(dataChannel.value);
  };

  // Create a data channel immediately if we are the offerer
  dataChannel.value = peerConnection.value.createDataChannel("file-transfer-channel", {
    ordered: true, // Guarantees order
    maxRetransmits: 0 // Optional: no retransmits for faster but less reliable transfer
  });
  addLog('system', 'Created DataChannel for file transfer.');
  setupDataChannelListeners(dataChannel.value);
};

const setupDataChannelListeners = (channel) => {
  channel.onopen = () => {
    addLog('system', `DataChannel opened: ${channel.label}`);
    // Clear any previous error messages related to DC state
    fileTransferError.value = '';
  };

  channel.onclose = () => {
    addLog('system', `DataChannel closed: ${channel.label}`);
    dataChannel.value = null; // Clear reference
    sendFileProgress.value = 0; // Reset progress
  };

  channel.onerror = (error) => {
    addLog('error', `DataChannel Error: ${error.message || error}`);
    fileTransferError.value = `Data channel error: ${error.message || 'Unknown error'}`;
  };

  channel.onmessage = async (event) => {
    // WebRTC DataChannel can send ArrayBuffer directly!
    const receivedData = event.data;

    try {
      if (typeof receivedData === 'string') {
        // This is likely a JSON signaling message for file transfer (metadata or completion)
        const parsedData = JSON.parse(receivedData);
        if (parsedData.type === 'file-metadata-signal') {
          const { fileId, fileName, fileType, fileSize } = parsedData;
          addLog('received', `Received file metadata for ${fileName} (ID: ${fileId}) from peer`);
          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: [], // Store ArrayBuffer chunks
            receivedSize: 0,
            from: selectedPeerId.value, // The sender is the connected peer
            progress: 0,
            index: receivedFiles.length // To display it in order
          };
          receivedFiles.push(incomingFileBuffers[fileId]); // Add to display list immediately
        } else if (parsedData.type === 'file-transfer-complete-signal') {
          const { fileId, fileName } = parsedData;
          addLog('received', `File transfer complete signal for ${fileName} (ID: ${fileId})`);
          // File reassembly logic happens at the last chunk. This is just a confirmation.
        } else {
          addLog('received', `DataChannel String: ${receivedData}`);
        }
      } else if (receivedData instanceof ArrayBuffer) {
        // This is a binary file chunk!
        const view = new DataView(receivedData);
        const fileIdLen = view.getUint8(0);
        const fileId = new TextDecoder().decode(receivedData.slice(1, 1 + fileIdLen));
        const chunkIndex = view.getUint32(1 + fileIdLen, true); // true for little-endian
        const isLastChunk = view.getUint8(1 + fileIdLen + 4) === 1;
        const chunkData = receivedData.slice(1 + fileIdLen + 4 + 1); // Remaining is actual data

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

        // addLog('received', `Received chunk ${chunkIndex} for ${fileBuffer.metadata.fileName} (ID: ${fileId})`);

        if (isLastChunk) {
          addLog('received', `Last chunk received for ${fileBuffer.metadata.fileName} (ID: ${fileId}). Reassembling...`);
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          // Find the item in receivedFiles and update its URL
          if (reactiveFileItem) {
              reactiveFileItem.url = url;
              reactiveFileItem.progress = 100; // Ensure it shows 100%
          }

          delete incomingFileBuffers[fileId]; // Clean up buffer
          addLog('system', `File reassembled and ready for download: ${fileBuffer.metadata.fileName}`);
        }
      }
    } catch (e) {
      addLog('error', `Error processing DataChannel message: ${e.message}`);
    }
  };
};


const concatenateArrayBuffers = (buffers) => {
    let totalLength = 0;
    for (const buffer of buffers) {
        if (buffer) { // Ensure buffer exists for sparse arrays
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


const closePeerConnection = () => {
  if (dataChannel.value) {
    dataChannel.value.close();
    dataChannel.value = null;
  }
  if (peerConnection.value) {
    peerConnection.value.close();
    peerConnection.value = null;
  }
  isPeerConnected.value = false;
  addLog('system', 'Peer connection closed.');
};

// --- WebRTC Signaling Message Handlers (Send to signaling server) ---
const sendSignalingMessage = (type, payload) => {
    if (ws.value && ws.value.readyState === WebSocket.OPEN && selectedPeerId.value) {
        const message = {
            type: type,
            to: selectedPeerId.value,
            ...payload
        };
        ws.value.send(JSON.stringify(message));
    } else {
        addLog('error', `Cannot send signaling message: WS not open or no peer selected for ${type}`);
    }
};

const createOffer = async () => {
  if (!selectedPeerId.value) {
    fileTransferError.value = 'Please select a peer to connect to.';
    return;
  }
  createPeerConnection(selectedPeerId.value); // Re-create connection for new offer

  try {
    const offer = await peerConnection.value.createOffer();
    await peerConnection.value.setLocalDescription(offer);
    sendSignalingMessage('offer', { sdp: offer });
    addLog('sent', `Sent WebRTC Offer to ${selectedPeerId.value}`);
  } catch (error) {
    addLog('error', `Error creating offer: ${error.message}`);
    fileTransferError.value = `Error creating offer: ${error.message}`;
  }
};

const handleOffer = async (sdp, fromId) => {
  // If we receive an offer, we are the answerer
  // Ensure we are talking to the same peer (or allow new connection)
  if (peerConnection.value && selectedPeerId.value !== fromId && isPeerConnected.value) {
    addLog('system', `Already connected to a peer. Ignoring offer from ${fromId}.`);
    return; // Or handle multiple peer connections if desired
  }
  selectedPeerId.value = fromId; // Automatically set the peer we are answering
  createPeerConnection(fromId); // Create connection for answering

  try {
    await peerConnection.value.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.value.createAnswer();
    await peerConnection.value.setLocalDescription(answer);
    sendSignalingMessage('answer', { sdp: answer });
    addLog('sent', `Sent WebRTC Answer to ${fromId}`);
  } catch (error) {
    addLog('error', `Error handling offer: ${error.message}`);
    fileTransferError.value = `Error handling offer: ${error.message}`;
  }
};

const handleAnswer = async (sdp) => {
  try {
    await peerConnection.value.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    addLog('error', `Error handling answer: ${error.message}`);
    fileTransferError.value = `Error handling answer: ${error.message}`;
  }
};

const handleCandidate = async (candidate) => {
  try {
    await peerConnection.value.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    addLog('error', `Error adding ICE candidate: ${error.message}`);
    // fileTransferError.value = `Error adding ICE candidate: ${error.message}`; // Too verbose
  }
};

// --- File Selection & Sending Logic ---
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendFileProgress.value = 0;
  fileTransferError.value = '';
};

const sendFile = async () => {
  if (!dataChannel.value || dataChannel.value.readyState !== 'open') {
    fileTransferError.value = 'Data Channel is not open. Please establish a peer connection first.';
    return;
  }
  if (!selectedFile.value) {
    fileTransferError.value = 'No file selected.';
    return;
  }

  const file = selectedFile.value;
  const fileId = `${mySessionId.value}-${Date.now()}-${file.name}`; // Unique ID for this file transfer

  // 1. Send file metadata over the data channel (as a JSON string)
  const metadata = {
    type: 'file-metadata-signal', // This type is for the *data channel* listener
    fileId: fileId,
    fileName: file.name,
    fileType: file.type || 'application/octet-stream',
    fileSize: file.size,
    from: mySessionId.value // Let receiver know who sent it
  };
  dataChannel.value.send(JSON.stringify(metadata));
  addLog('sent', `Sent file metadata to peer for ${file.name} (ID: ${fileId})`);

  // 2. Send file chunks as ArrayBuffer
  let offset = 0;
  sendFileProgress.value = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    const chunk = e.target.result; // This is an ArrayBuffer
    const header = new Uint8Array(1 + 4 + 1 + new TextEncoder().encode(fileId).byteLength); // fileIdLen (1 byte) + fileId + chunkIndex (4 bytes) + isLastChunk (1 byte)
    let headerOffset = 0;

    // Encode fileId
    const fileIdBytes = new TextEncoder().encode(fileId);
    header[headerOffset++] = fileIdBytes.byteLength; // Length of fileId
    header.set(fileIdBytes, headerOffset);
    headerOffset += fileIdBytes.byteLength;

    // Encode chunkIndex
    const chunkIndex = Math.floor(offset / CHUNK_SIZE);
    new DataView(header.buffer).setUint32(headerOffset, chunkIndex, true); // true for little-endian
    headerOffset += 4;

    // Encode isLastChunk
    const isLastChunk = (offset + chunk.byteLength) >= file.size;
    header[headerOffset++] = isLastChunk ? 1 : 0;

    // Concatenate header and chunk data
    const combinedBuffer = new Uint8Array(header.byteLength + chunk.byteLength);
    combinedBuffer.set(header, 0);
    combinedBuffer.set(new Uint8Array(chunk), header.byteLength);

    dataChannel.value.send(combinedBuffer.buffer); // Send ArrayBuffer!

    offset += chunk.byteLength;
    sendFileProgress.value = (offset / file.size) * 100;

    if (offset < file.size) {
      readNextChunk();
    } else {
      addLog('sent', `Finished sending all chunks for ${file.name}`);
      // Send a final completion signal over the data channel (as JSON string)
      dataChannel.value.send(JSON.stringify({
        type: 'file-transfer-complete-signal',
        fileId: fileId,
        fileName: file.name,
        from: mySessionId.value
      }));
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
  if (peerConnection.value) {
    peerConnection.value.close();
  }
});
</script>

<style scoped>
/* Keep your existing CSS styles from the previous example */
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