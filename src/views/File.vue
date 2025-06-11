<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC文件快传</h2>

    <div class="file-transfer-section">
      <h3>选择文件</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFileBroadcast" :disabled="!selectedFile">
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
      <h3>接收文件</h3>
      <ul v-if="receivedFiles.length > 0">
        <li v-for="(file, index) in receivedFiles" :key="index" class="received-file-item">
          <p>
            <span class="file-info">{{ file.metadata.fileName }}({{ formatBytes(file.metadata.fileSize) }})</span>
            <a :href="file.url" :download="file.metadata.fileName" class="download-link">Download</a>
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
const mySessionId = ref('');
const heartbeatIntervalId = ref(null); // 用于存放我们的心跳定时器ID

const peerConnections = reactive({});

const selectedFile = ref(null);
const sendFileProgress = ref(0);
const fileTransferError = ref('');

const receivedFiles = reactive([]);

const incomingFileBuffers = {};

// --- WebRTC Configuration ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
};

// --- File Transfer Constants ---
const CHUNK_SIZE = 16 * 1024;

const wsUrl = 'ws://59.110.35.198/wgk/ws/file'; // Your WebSocket signaling server URL

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

// Removed addLog function and all its calls



  // --- 新增心跳函数 ---
  const startHeartbeat = () => {
    console.log('启动心跳机制...');
    heartbeatIntervalId.value = setInterval(() => {
      if (ws.value && ws.value.readyState === WebSocket.OPEN) {
        // 发送 ping 消息
        sendMessage({ type: 'ping' });
      }
    }, 30000); // 每 30 秒发送一次
  };


  const sendMessage = (message) => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify(message));
  } else {
    console.error("无法发送消息，WebSocket 未连接。");
  }
};

    const stopHeartbeat = () => {
    console.log('停止心跳机制...');
    if (heartbeatIntervalId.value) {
      clearInterval(heartbeatIntervalId.value);
      heartbeatIntervalId.value = null;
    }
  };

// --- WebSocket Signaling Logic ---
const connectWebSocket = () => {
  ws.value = new WebSocket(wsUrl);

  ws.value.onopen = () => {
    startHeartbeat(); 
    isWsConnected.value = true;
    // Periodically send ping to keep connection alive
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

      if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        return;
      }

      if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        const onlinePeers = parsedMessage.users.filter(id => id !== mySessionId.value);
        const currentConnectedPeers = Object.keys(peerConnections);

        onlinePeers.forEach(peerId => {
          if (!currentConnectedPeers.includes(peerId) && !peerConnections[peerId]) {
            if (mySessionId.value < peerId) {
                createOffer(peerId);
            }
          }
        });

        currentConnectedPeers.forEach(peerId => {
          if (!onlinePeers.includes(peerId)) {
            closePeerConnection(peerId);
          }
        });
        return;
      }

      const fromId = parsedMessage.from;
      if (!fromId) {
        // console.error(`Received message with no 'from' field: ${message}`); // Removed for production, kept for potential silent debugging
        return;
      }

      if (parsedMessage.type === 'offer') {
        await handleOffer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'answer') {
        await handleAnswer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'candidate') {
        await handleCandidate(parsedMessage.candidate, fromId);
      } else if (parsedMessage.type === 'user-left') {
        closePeerConnection(fromId);
      } else {
        // console.warn(`Unexpected signaling from ${fromId}: ${JSON.stringify(parsedMessage)}`); // Removed for production, kept for potential silent debugging
      }
    } catch (e) {
      // console.error(`Error processing WS message: ${message}. Error: ${e.message}`); // Removed for production, kept for potential silent debugging
    }
  };

  ws.value.onclose = () => {
    isWsConnected.value = false;
    Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    // console.error(`WebSocket Error: ${error.message || error}`); // Removed for production, kept for potential silent debugging
    ws.value.close();
  };
};

// --- WebRTC Peer Connection Logic ---
const createPeerConnection = (targetPeerId, isOfferer = true) => {
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
      peerConnections[targetPeerId].pc.connectionState !== 'closed' &&
      peerConnections[targetPeerId].pc.iceConnectionState !== 'failed' &&
      peerConnections[targetPeerId].pc.iceConnectionState !== 'disconnected') {
    return peerConnections[targetPeerId].pc;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetPeerId] = { pc: pc, dc: null };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.value.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        to: targetPeerId
      }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      closePeerConnection(targetPeerId);
    }
  };

  pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          closePeerConnection(targetPeerId);
      }
  };

  pc.ondatachannel = (event) => {
    peerConnections[targetPeerId].dc = event.channel;
    setupDataChannelListeners(event.channel, targetPeerId);
  };

  if (isOfferer) {
    const dc = pc.createDataChannel("file-transfer-channel", {
      ordered: true,
      maxRetransmits: 0
    });
    peerConnections[targetPeerId].dc = dc;
    setupDataChannelListeners(dc, targetPeerId);
  }
  return pc;
};

const setupDataChannelListeners = (channel, peerId) => {
  channel.onopen = () => {
    fileTransferError.value = '';
  };

  channel.onclose = () => {
    if (peerConnections[peerId]) {
        peerConnections[peerId].dc = null;
    }
  };

  channel.onerror = (error) => {
    // console.error(`[${peerId}] DataChannel Error: ${error.message || error}`); // Removed for production, kept for potential silent debugging
  };

  channel.onmessage = async (event) => {
    const receivedData = event.data;

    try {
      if (typeof receivedData === 'string') {
        const parsedData = JSON.parse(receivedData);
        if (parsedData.type === 'file-metadata-signal') {
          const { fileId, fileName, fileType, fileSize, from } = parsedData;
          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: [],
            receivedSize: 0,
            from: from,
            progress: 0,
            index: receivedFiles.length,
          };
          receivedFiles.push(incomingFileBuffers[fileId]);
        } else if (parsedData.type === 'file-transfer-complete-signal') {
          // File reassembly happens on last chunk, this is confirmation.
        } else {
          // console.warn(`[${peerId}] DataChannel String: ${receivedData}`); // Removed for production, kept for potential silent debugging
        }
      } else if (receivedData instanceof ArrayBuffer) {
        const view = new DataView(receivedData);
        const fileIdLen = view.getUint8(0);
        const fileId = new TextDecoder().decode(receivedData.slice(1, 1 + fileIdLen));
        const chunkIndex = view.getUint32(1 + fileIdLen, true);
        const isLastChunk = view.getUint8(1 + fileIdLen + 4) === 1;
        const chunkData = receivedData.slice(1 + fileIdLen + 4 + 1);

        if (!incomingFileBuffers[fileId]) {
          // console.error(`Received chunk for unknown file ID: ${fileId}. Metadata might be missing.`); // Removed for production, kept for potential silent debugging
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
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          if (reactiveFileItem) {
              reactiveFileItem.url = url;
              reactiveFileItem.progress = 100;
          }

          delete incomingFileBuffers[fileId];
        }
      }
    } catch (e) {
      // console.error(`Error processing DataChannel message from ${peerId}: ${e.message}`); // Removed for production, kept for potential silent debugging
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
        // console.error(`Cannot send signaling message to ${toId}: WS not open or missing target for ${type}`); // Removed for production, kept for potential silent debugging
    }
};

const createOffer = async (targetPeerId) => {
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
      peerConnections[targetPeerId].pc.localDescription && peerConnections[targetPeerId].pc.localDescription.type === 'offer') {
      return;
  }

  const pc = createPeerConnection(targetPeerId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingMessage('offer', { sdp: offer }, targetPeerId);
  } catch (error) {
    // console.error(`Error creating offer for ${targetPeerId}: ${error.message}`); // Removed for production, kept for potential silent debugging
  }
};

const handleOffer = async (sdp, fromId) => {
  const pc = createPeerConnection(fromId, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignalingMessage('answer', { sdp: answer }, fromId);
  } catch (error) {
    // console.error(`Error handling offer from ${fromId}: ${error.message}`); // Removed for production, kept for potential silent debugging
  }
};

const handleAnswer = async (sdp, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    return;
  }
  try {
    if (pcInfo.pc.signalingState !== 'have-local-offer') {
        // console.warn(`[${fromId}] Received answer while in state ${pcInfo.pc.signalingState}. Expected 'have-local-offer'.`); // Removed for production, kept for potential silent debugging
    }
    await pcInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    // console.error(`Error handling answer from ${fromId}: ${error.message}`); // Removed for production, kept for potential silent debugging
  }
};

const handleCandidate = async (candidate, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    return;
  }
  try {
    await pcInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    // console.error(`[${fromId}] Error adding ICE candidate: ${error.message}`); // Removed for production, kept for potential silent debugging
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
    } catch (e) {
      // console.error(`Failed to send metadata via data channel: ${e.message}`); // Removed for production, kept for potential silent debugging
    }
  });

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
            // console.error(`Failed to send file chunk via data channel: ${e.message}`); // Removed for production, kept for potential silent debugging
        }
    });

    offset += chunk.byteLength;
    sendFileProgress.value = (offset / file.size) * 100;

    if (offset < file.size) {
      readNextChunk();
    } else {
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
              // console.error(`Failed to send completion signal via data channel: ${e.message}`); // Removed for production, kept for potential silent debugging
          }
      });

      selectedFile.value = null;
      if (document.querySelector('input[type="file"]')) {
        document.querySelector('input[type="file"]').value = '';
      }
    }
  };

  reader.onerror = (error) => {
    console.error('FileReader error:', error); // Keep console error for unexpected file read issues
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
.webrtc-file-transfer-container {
  font-family: Arial, sans-serif;
  max-width: 600px;
  margin: 20px auto;
  padding: 25px;
  border: 1px solid #ddd;
  border-radius: 10px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
  background-color: #ffffff;
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
  background-color: #e8f5e9;
  border: 1px solid #a5d6a7;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 25px;
  text-align: center;
}

.connection-info p {
  margin: 5px 0;
  font-size: 1em;
  color: #388e3c;
}

.my-id, .connected-peers-count {
  font-weight: bold;
  color: #1b5e20;
}

.status-connected {
  color: #28a745;
  font-weight: bold;
}

.status-disconnected {
  color: #dc3545;
  font-weight: bold;
}

.file-transfer-section {
  background-color: #f8f9fa;
  border: 1px solid #e9ecef;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 25px;
}

.file-transfer-section input[type="file"] {
  display: block;
  width: calc(100% - 20px);
  padding: 10px;
  border: 1px solid #ced4da;
  border-radius: 5px;
  margin-bottom: 15px;
  box-sizing: border-box;
}

.file-transfer-section button {
  width: 100%;
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
  height: 25px;
  position: relative;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background-color: #28a745;
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
    line-height: 25px;
    color: #333;
    font-size: 0.9em;
    font-weight: bold;
    text-shadow: 0 0 2px rgba(255,255,255,0.7);
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
</style>