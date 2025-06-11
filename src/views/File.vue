<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC 极速文件传输</h2>

    <div class="connection-info">
      <h3>连接状态</h3>
      <p>我的会话ID: <span class="my-id">{{ mySessionId || '未连接' }}</span></p>
      <p>WebSocket 状态:
        <span :class="wsStatus.class">{{ wsStatus.text }}</span>
      </p>
      <p>活跃对等端: <span class="connected-peers-count">{{ activePeersCount }}</span></p>
      <p>传输速度: <span class="transfer-speed">{{ formatSpeed(currentSendSpeed) }}</span></p>
    </div>

    <div class="file-transfer-section">
      <h3>文件发送</h3>
      <input type="file" @change="handleFileSelection" ref="fileInput" />
      <button @click="startFileTransfer" :disabled="!selectedFile || activePeersCount === 0 || isTransferring">
        {{ isTransferring ? '正在发送...' : '极速广播文件' }}
      </button>
      <div v-if="selectedFile" class="file-info">
        <p>已选文件: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
        <p>分块大小: {{ formatBytes(CHUNK_SIZE) }}</p>
      </div>
      <div class="progress-container" v-if="selectedFile">
        <div class="progress-bar" :style="{ width: sendProgress + '%' }"></div>
        <span class="progress-text">{{ sendProgress.toFixed(1) }}%</span>
        <span class="speed-indicator">{{ formatSpeed(currentSendSpeed) }}/s</span>
      </div>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
    </div>

    <div class="received-files-section">
      <h3>接收文件</h3>
      <div v-if="receivedFiles.length" class="file-list">
        <div v-for="file in receivedFiles" :key="file.id" class="file-item">
          <div class="file-header">
            <span class="file-name">{{ file.name }}</span>
            <span class="file-size">{{ formatBytes(file.size) }}</span>
            <a v-if="file.progress === 100" :href="file.url" :download="file.name" class="download-btn">下载</a>
          </div>
          <div class="file-progress">
            <div class="progress-bar" :style="{ width: file.progress + '%' }"></div>
            <span class="progress-text">{{ file.progress.toFixed(1) }}%</span>
          </div>
        </div>
      </div>
      <p v-else class="empty-message">暂无接收文件</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';

// --- Configuration Constants ---
const WS_URL = 'ws://59.110.35.198/wgk/ws/file';
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }];
const CHUNK_SIZE = 64 * 1024; // Smaller chunks (e.g., 64KB-256KB) can be more responsive to congestion
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB for data channel buffer, adjust based on testing
const RETRANSMIT_TIMEOUT = 1000; // 1 second for retransmission timeout
const MAX_RETRANSMITS = 5; // Max retries for a chunk
const HEARTBEAT_INTERVAL = 25000;

// --- Reactive State ---
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const errorMessage = ref('');
const isTransferring = ref(false);

// Map to store RTCPeerConnection instances, keyed by peerId
const peerConnections = reactive({});

// Stores ongoing outgoing file transfers
const outgoingTransfers = reactive({}); // { fileId: { file, peers: { peerId: { chunksToSend, sentChunks, ackedChunks, ... } } } }

// Stores incoming file data and metadata
const incomingFiles = reactive({}); // { fileId: { name, size, type, chunks: {}, receivedSize, progress, url } }

// UI related reactive states for transfer progress and speed
const totalBytesSent = ref(0);
const lastSpeedCalcTime = ref(0);
const lastBytesSentForSpeed = ref(0);
const currentSendSpeed = ref(0); // bytes/s
const sendProgress = ref(0); // Overall send progress

// List of received files for UI display
const receivedFiles = reactive([]); // [{ id, name, size, progress, url }]

// --- Computed Properties ---
const wsStatus = computed(() => {
  if (!ws.value) return { class: 'disconnected', text: '未连接' };
  switch (ws.value.readyState) {
    case WebSocket.OPEN: return { class: 'connected', text: '已连接' };
    case WebSocket.CONNECTING: return { class: 'connecting', text: '连接中' };
    case WebSocket.CLOSING: return { class: 'disconnected', text: '关闭中' };
    case WebSocket.CLOSED: return { class: 'disconnected', text: '已断开' };
    default: return { class: 'disconnected', text: '未知' };
  }
});

const activePeersCount = computed(() => Object.keys(peerConnections).length);

// --- Utility Functions ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
};

const formatSpeed = (bytes) => {
  return formatBytes(bytes); // Will append "/s" in template
};

const generateUniqueId = () => {
  return `${mySessionId.value}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

const sendWsMessage = (type, data = {}, to = null) => {
  if (ws.value?.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not open, cannot send message:', type);
    return;
  }
  const message = { type, ...data };
  if (to) message.to = to;
  ws.value.send(JSON.stringify(message));
};

let heartbeatIntervalId;
const startHeartbeat = () => {
  stopHeartbeat(); // Clear any existing heartbeat
  heartbeatIntervalId = setInterval(() => {
    if (ws.value?.readyState === WebSocket.OPEN) {
      sendWsMessage('ping');
    } else {
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL);
};

const stopHeartbeat = () => {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
};

// --- WebSocket Signaling Logic ---
const connectWebSocket = () => {
  if (ws.value?.readyState === WebSocket.OPEN || ws.value?.readyState === WebSocket.CONNECTING) return;

  ws.value = new WebSocket(WS_URL);

  ws.value.onopen = () => {
    console.log('WebSocket connection established.');
    startHeartbeat();
    sendWsMessage('get-users'); // Request user list on connect
  };

  ws.value.onmessage = async (event) => {
    if (event.data === 'pong') return; // Heartbeat response

    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'session-id':
          mySessionId.value = msg.id;
          console.log('My session ID:', mySessionId.value);
          break;
        case 'user-list':
          handleUserList(msg.users);
          break;
        case 'offer':
          await handleSignalingOffer(msg.sdp, msg.from);
          break;
        case 'answer':
          await handleSignalingAnswer(msg.sdp, msg.from);
          break;
        case 'candidate':
          await handleSignalingCandidate(msg.candidate, msg.from);
          break;
        case 'user-left':
          console.log(`User ${msg.from} left.`);
          closePeerConnection(msg.from);
          break;
        default:
          console.warn('Unknown WebSocket message type:', msg.type, msg);
      }
    } catch (error) {
      console.error('Error parsing or handling WebSocket message:', error, event.data);
    }
  };

  ws.value.onclose = () => {
    console.log('WebSocket connection closed. Reconnecting...');
    stopHeartbeat();
    // Clear all peer connections on WebSocket close to avoid stale states
    Object.keys(peerConnections).forEach(closePeerConnection);
    setTimeout(connectWebSocket, 5000); // Attempt to reconnect after 5 seconds
  };

  ws.value.onerror = (error) => {
    console.error('WebSocket error:', error);
    ws.value?.close(); // Force close to trigger onclose and reconnect
  };
};

const handleUserList = (users) => {
  const onlinePeers = new Set(users.filter(id => id !== mySessionId.value));
  const currentPeers = new Set(Object.keys(peerConnections));

  // Add new peers: If we are the "smaller" ID, we initiate the offer
  onlinePeers.forEach(peerId => {
    if (!currentPeers.has(peerId)) {
      createPeerConnection(peerId); // Create PC, but don't offer yet
      if (mySessionId.value < peerId) {
        createOffer(peerId);
      }
    }
  });

  // Remove disconnected peers
  currentPeers.forEach(peerId => {
    if (!onlinePeers.has(peerId)) {
      closePeerConnection(peerId);
    }
  });
};

// --- WebRTC Peer Connection Management ---
const createPeerConnection = (peerId) => {
  if (peerConnections[peerId]) {
    console.log(`PeerConnection with ${peerId} already exists.`);
    return peerConnections[peerId].pc;
  }

  console.log(`Creating RTCPeerConnection for peer: ${peerId}`);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Store PC and data channel reference
  peerConnections[peerId] = {
    pc,
    dataChannel: null,
    status: 'connecting', // 'connecting', 'connected', 'disconnected'
    outgoingQueue: [], // Queue for file chunks to send
    incomingFileTransfer: null, // Current incoming file
    lastBufferedAmountCheck: Date.now() // For flow control
  };

  // Setup Data Channel for sending
  const dataChannel = pc.createDataChannel('file-transfer-channel', {
    ordered: true, // Guarantees order
    maxRetransmits: 0 // Retransmission handled by WebRTC internally, set to 0 to prefer speed
  });
  peerConnections[peerId].dataChannel = dataChannel;
  setupDataChannel(dataChannel, peerId);

  // Event handlers for the PeerConnection
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWsMessage('candidate', { candidate: event.candidate }, peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`PeerConnection state with ${peerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      closePeerConnection(peerId);
    } else if (pc.connectionState === 'connected') {
      peerConnections[peerId].status = 'connected';
      console.log(`Peer ${peerId} connected!`);
      // Start processing queue if anything was waiting
      processOutgoingQueue(peerId);
    }
  };

  // Handle incoming Data Channel setup (for answerer)
  pc.ondatachannel = (event) => {
    console.log(`Incoming DataChannel from ${peerId}: ${event.channel.label}`);
    const incomingDc = event.channel;
    peerConnections[peerId].dataChannel = incomingDc;
    setupDataChannel(incomingDc, peerId);
  };

  return pc;
};

const setupDataChannel = (dc, peerId) => {
  dc.onopen = () => {
    console.log(`DataChannel to ${peerId} opened!`);
    if (peerConnections[peerId]) {
      peerConnections[peerId].status = 'connected';
      processOutgoingQueue(peerId); // Start sending if there's data
    }
  };

  dc.onclose = () => {
    console.log(`DataChannel to ${peerId} closed.`);
    closePeerConnection(peerId);
  };

  dc.onerror = (error) => {
    console.error(`DataChannel error with ${peerId}:`, error);
    // Consider closing PC on severe data channel error
  };

  // Crucial for flow control: send more data when buffer is low
  dc.onbufferedamountlow = () => {
    // console.log(`DataChannel buffered amount low for ${peerId}`);
    processOutgoingQueue(peerId);
  };

  dc.onmessage = (event) => {
    handleReceivedData(event.data, peerId);
  };
};

const closePeerConnection = (peerId) => {
  if (!peerConnections[peerId]) return;

  console.log(`Closing PeerConnection with ${peerId}`);
  const { pc, dataChannel } = peerConnections[peerId];

  // Reject any pending transfers for this peer
  // (More sophisticated handling needed for multiple transfers)
  if (outgoingTransfers[peerId]?.resolve) { // Example: If transfer promise exists
    outgoingTransfers[peerId].reject(new Error(`Connection to ${peerId} closed.`));
  }

  if (dataChannel) {
    try {
      dataChannel.close();
    } catch (e) {
      console.error('Error closing data channel:', e);
    }
  }
  if (pc) {
    try {
      pc.close();
    } catch (e) {
      console.error('Error closing PeerConnection:', e);
    }
  }

  delete peerConnections[peerId];
  // Remove peer from any active transfer lists
  for (const fileId in outgoingTransfers) {
    if (outgoingTransfers[fileId].peers[peerId]) {
      delete outgoingTransfers[fileId].peers[peerId];
      // If no peers left for this transfer, mark as failed/completed
      if (Object.keys(outgoingTransfers[fileId].peers).length === 0) {
        console.log(`Transfer ${fileId} completed/failed for all peers.`);
        // Reset sending UI state if this was the active transfer
        if (selectedFile.value && outgoingTransfers[fileId].file.name === selectedFile.value.name) {
          isTransferring.value = false;
          sendProgress.value = 100; // Assume completion or failure handled
        }
        delete outgoingTransfers[fileId];
      }
    }
  }
};

const createOffer = async (peerId) => {
  const pc = peerConnections[peerId]?.pc;
  if (!pc) return;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWsMessage('offer', { sdp: offer }, peerId);
    console.log(`Sent offer to ${peerId}`);
  } catch (error) {
    console.error(`Failed to create offer for ${peerId}:`, error);
    closePeerConnection(peerId);
  }
};

const handleSignalingOffer = async (sdp, peerId) => {
  const pc = createPeerConnection(peerId); // Ensures PC exists for the answerer
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWsMessage('answer', { sdp: answer }, peerId);
    console.log(`Sent answer to ${peerId}`);
  } catch (error) {
    console.error(`Failed to handle offer from ${peerId}:`, error);
    closePeerConnection(peerId);
  }
};

const handleSignalingAnswer = async (sdp, peerId) => {
  const pc = peerConnections[peerId]?.pc;
  if (!pc) {
    console.warn(`Received answer for unknown peer ${peerId}`);
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    console.log(`Handled answer from ${peerId}`);
  } catch (error) {
    console.error(`Failed to handle answer from ${peerId}:`, error);
  }
};

const handleSignalingCandidate = async (candidate, peerId) => {
  const pc = peerConnections[peerId]?.pc;
  if (!pc) {
    console.warn(`Received ICE candidate for unknown peer ${peerId}`);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    // console.log(`Added ICE candidate from ${peerId}`);
  } catch (error) {
    // Ignore error if candidate is already added or PC is closed
    if (!error.message.includes('already added') && !error.message.includes('closed')) {
      console.error(`Failed to add ICE candidate from ${peerId}:`, error);
    }
  }
};

// --- File Sending Logic ---
const handleFileSelection = (event) => {
  selectedFile.value = event.target.files[0];
  errorMessage.value = '';
  sendProgress.value = 0;
  totalBytesSent.value = 0;
  currentSendSpeed.value = 0;
  isTransferring.value = false;
};

const startFileTransfer = async () => {
  if (!selectedFile.value) {
    errorMessage.value = '请先选择文件！';
    return;
  }
  const activePeers = Object.keys(peerConnections).filter(id => peerConnections[id].status === 'connected');

  if (activePeers.length === 0) {
    errorMessage.value = '没有可用的对等连接！';
    return;
  }

  isTransferring.value = true;
  errorMessage.value = '';
  sendProgress.value = 0;
  totalBytesSent.value = 0;
  currentSendSpeed.value = 0;
  lastSpeedCalcTime.value = Date.now();
  lastBytesSentForSpeed.value = 0;

  const file = selectedFile.value;
  const fileId = generateUniqueId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Initialize outgoing transfer state
  outgoingTransfers[fileId] = {
    file,
    fileId,
    totalChunks,
    sentChunks: new Set(), // Chunks sent for the first time
    ackedChunks: new Set(), // Chunks acknowledged by receiver
    pendingAcks: new Map(), // { chunkIndex: { timestamp, retries, data } }
    peers: {}, // { peerId: { currentChunkIndex, chunksInFlight, ... } }
    readers: {}, // Store FileReader for each peer to avoid conflict
    transferStartTime: Date.now(),
    isComplete: false,
    resolve: null,
    reject: null
  };

  const transferPromise = new Promise((resolve, reject) => {
    outgoingTransfers[fileId].resolve = resolve;
    outgoingTransfers[fileId].reject = reject;
  });

  // Prepare transfer for each connected peer
  activePeers.forEach(peerId => {
    outgoingTransfers[fileId].peers[peerId] = {
      currentChunkIndex: 0,
      chunksInFlight: 0, // Number of chunks sent but not yet ACKed
      lastSendTime: 0,
      isPeerComplete: false,
      reader: new FileReader() // Dedicated FileReader per peer
    };
    // Send initial metadata
    sendMetaData(peerConnections[peerId].dataChannel, fileId, file.name, file.size, file.type || 'application/octet-stream');
    // Start processing queue for this peer
    processOutgoingQueue(peerId);
  });

  try {
    await transferPromise;
    console.log('File transfer completed successfully!');
    isTransferring.value = false;
    sendProgress.value = 100;
  } catch (error) {
    console.error('File transfer failed:', error);
    errorMessage.value = `文件传输失败: ${error.message}`;
    isTransferring.value = false;
    // Potentially reset progress to 0 or leave at current state
  } finally {
    delete outgoingTransfers[fileId]; // Clean up
  }
};

const sendMetaData = (dc, fileId, name, size, type) => {
  const metadata = {
    type: 'file-metadata',
    fileId,
    name,
    size,
    fileType: type, // Avoid 'type' collision with message type
    chunkSize: CHUNK_SIZE // Inform receiver about chunk size
  };
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`Sent metadata for file ${fileId} to ${dc.label}`);
  } catch (e) {
    console.error('Error sending metadata:', e);
  }
};

// Process the outgoing queue for a specific peer
const processOutgoingQueue = async (peerId) => {
  const peer = peerConnections[peerId];
  if (!peer || peer.status !== 'connected' || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
    return;
  }

  const dc = peer.dataChannel;

  // Check if buffer is full, if so, wait for onbufferedamountlow
  if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    // console.log(`Buffered amount for ${peerId} is high: ${formatBytes(dc.bufferedAmount)}`);
    return;
  }

  // Iterate over active transfers and send chunks
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    const peerTransfer = transfer.peers[peerId];

    if (!peerTransfer || peerTransfer.isPeerComplete) continue;

    // Send the next unacked chunk
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.ackedChunks.has(i) && !transfer.pendingAcks.has(i)) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
        const slice = transfer.file.slice(start, end);

        // Use dedicated FileReader for this peer
        try {
          const chunkData = await new Promise((resolve, reject) => {
            peerTransfer.reader.onload = e => resolve(e.target.result);
            peerTransfer.reader.onerror = e => reject(e.target.error);
            peerTransfer.reader.readAsArrayBuffer(slice);
          });

          const packet = createDataPacket(transfer.fileId, i, chunkData);
          dc.send(packet);
          // console.log(`Sent chunk ${i} for file ${fileId} to ${peerId}`);

          transfer.sentChunks.add(i);
          transfer.pendingAcks.set(i, {
            timestamp: Date.now(),
            retries: 0,
            data: packet // Store the packet for retransmission
          });

          // Update total bytes sent for overall speed calculation
          totalBytesSent.value += chunkData.byteLength;
          updateSendProgress();

          // After sending, immediately try to send more if buffer allows
          if (dc.bufferedAmount < MAX_BUFFERED_SIZE * 0.8) {
            // Keep sending without yielding if buffer is low
            continue;
          } else {
            // console.log(`Buffer full for ${peerId}, waiting for onbufferedamountlow.`);
            return; // Exit loop, wait for onbufferedamountlow
          }

        } catch (error) {
          console.error(`Error reading chunk for ${peerId}:`, error);
          // Handle error, maybe mark transfer as failed for this peer
          peerTransfer.isPeerComplete = true; // Stop sending to this peer
          if (transfer.reject) transfer.reject(error);
          return;
        }
      }
    }

    // If all chunks are sent and pending (or acked), check if transfer is fully complete for this peer
    if (transfer.sentChunks.size === transfer.totalChunks && transfer.pendingAcks.size === 0 && !peerTransfer.isPeerComplete) {
      // Send a completion message if all chunks are acknowledged
      sendCompletionMessage(dc, fileId);
      peerTransfer.isPeerComplete = true;
      console.log(`File ${fileId} transfer completed for peer ${peerId}`);
    }

    // Check if the overall transfer is complete for all peers
    const allPeersComplete = Object.values(transfer.peers).every(p => p.isPeerComplete);
    if (allPeersComplete && !transfer.isComplete) {
      transfer.isComplete = true;
      if (transfer.resolve) transfer.resolve();
    }
  }
};

const createDataPacket = (fileId, chunkIndex, chunkData) => {
  // Packet format: [fileId_length (1 byte)] + [fileId (variable)] + [chunkIndex (4 bytes)] + [chunkData]
  const fileIdBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(1 + fileIdBytes.length + 4);

  let offset = 0;
  header[offset++] = fileIdBytes.length; // Length of fileId
  header.set(fileIdBytes, offset); // FileId bytes
  offset += fileIdBytes.length;

  new DataView(header.buffer).setUint32(offset, chunkIndex, true); // Chunk index (little-endian)

  const packet = new Uint8Array(header.length + chunkData.byteLength);
  packet.set(header, 0);
  packet.set(new Uint8Array(chunkData), header.length); // Actual chunk data

  return packet.buffer;
};

const sendCompletionMessage = (dc, fileId) => {
  const completionMsg = {
    type: 'file-transfer-complete',
    fileId: fileId
  };
  try {
    dc.send(JSON.stringify(completionMsg));
    console.log(`Sent completion message for ${fileId}`);
  } catch (e) {
    console.error('Error sending completion message:', e);
  }
};

// Retransmission timer
let retransmissionTimer = null;
const startRetransmissionTimer = () => {
  if (retransmissionTimer) return;
  retransmissionTimer = setInterval(() => {
    for (const fileId in outgoingTransfers) {
      const transfer = outgoingTransfers[fileId];
      if (transfer.isComplete) continue;

      transfer.pendingAcks.forEach((item, chunkIndex) => {
        if (Date.now() - item.timestamp > RETRANSMIT_TIMEOUT) {
          if (item.retries < MAX_RETRANSMITS) {
            console.warn(`Retransmitting chunk ${chunkIndex} for ${fileId} (retry ${item.retries + 1})`);
            // Find an open data channel to send it
            for (const peerId in transfer.peers) {
              const peer = peerConnections[peerId];
              if (peer?.dataChannel?.readyState === 'open' && !transfer.peers[peerId].isPeerComplete) {
                 // Check buffer before retransmitting
                if (peer.dataChannel.bufferedAmount < MAX_BUFFERED_AMOUNT) {
                  peer.dataChannel.send(item.data);
                  item.timestamp = Date.now(); // Reset timestamp
                  item.retries++;
                  // Only retransmit once per timeout, then check next
                  return;
                }
              }
            }
          } else {
            console.error(`Max retransmits reached for chunk ${chunkIndex} of ${fileId}. Transfer failed.`);
            transfer.pendingAcks.delete(chunkIndex); // Remove from pending
            if (transfer.reject) transfer.reject(new Error(`Max retransmits for chunk ${chunkIndex} reached.`));
            // Mark the entire transfer as failed for all peers if this chunk is critical
            transfer.isComplete = true; // Stop further processing
          }
        }
      });
    }
    // If no active transfers, stop the timer
    if (Object.keys(outgoingTransfers).length === 0) {
      stopRetransmissionTimer();
    }
  }, 500); // Check every 500ms
};

const stopRetransmissionTimer = () => {
  if (retransmissionTimer) {
    clearInterval(retransmissionTimer);
    retransmissionTimer = null;
  }
};

const updateSendProgress = () => {
  const now = Date.now();
  if (now - lastSpeedCalcTime.value > 200) { // Update speed every 200ms
    const timeDiffSeconds = (now - lastSpeedCalcTime.value) / 1000;
    const bytesDiff = totalBytesSent.value - lastBytesSentForSpeed.value;
    currentSendSpeed.value = bytesDiff / timeDiffSeconds;
    lastBytesSentForSpeed.value = totalBytesSent.value;
    lastSpeedCalcTime.value = now;
  }

  // Calculate overall progress based on the selected file
  if (selectedFile.value && selectedFile.value.size > 0) {
    // This is a simplified progress. For multi-peer broadcast, consider avg progress or min progress.
    // Here, we'll calculate based on how much has been ACKed across all peers for the *first* file.
    // For simplicity, let's just use the `totalBytesSent` as an indicator of overall progress.
    // A more precise approach would involve tracking ACKed bytes for the current broadcast file.
    sendProgress.value = (totalBytesSent.value / selectedFile.value.size) * 100;
    if (sendProgress.value > 100) sendProgress.value = 100;
  } else {
    sendProgress.value = 0;
  }
};

// --- File Receiving Logic ---
const handleReceivedData = (data, peerId) => {
  try {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'file-metadata') {
        initiateIncomingFile(msg, peerId);
      } else if (msg.type === 'file-transfer-complete') {
        finalizeIncomingFile(msg.fileId, peerId);
      } else if (msg.type === 'chunk-ack') {
        handleChunkAck(msg.fileId, msg.chunkIndex, peerId);
      }
    } else if (data instanceof ArrayBuffer) {
      processIncomingChunk(data, peerId);
    }
  } catch (e) {
    console.error('Error processing received data:', e);
  }
};

const initiateIncomingFile = (metadata, peerId) => {
  const { fileId, name, size, fileType, chunkSize } = metadata;
  if (incomingFiles[fileId]) {
    console.warn(`Metadata for ${fileId} already received from ${peerId}.`);
    return; // Already initialized
  }

  console.log(`Initiating incoming file: ${name} (${formatBytes(size)}) from ${peerId}`);
  const totalChunks = Math.ceil(size / chunkSize);

  const newIncomingFile = reactive({
    id: fileId,
    name,
    size,
    type: fileType,
    chunkSize,
    totalChunks,
    receivedChunks: new Map(), // { chunkIndex: ArrayBuffer }
    receivedSize: 0,
    progress: 0,
    url: null,
    peerSource: peerId // Keep track of which peer sent this file
  });
  incomingFiles[fileId] = newIncomingFile;

  // Add to UI list if not already there (multiple peers might send same file)
  const existingUiFile = receivedFiles.find(f => f.id === fileId);
  if (!existingUiFile) {
    receivedFiles.push(newIncomingFile);
  }
};

const processIncomingChunk = (chunkData, peerId) => {
  const view = new DataView(chunkData);
  let offset = 0;

  const fileIdLen = view.getUint8(offset++);
  const fileIdBytes = new Uint8Array(chunkData, offset, fileIdLen);
  const fileId = new TextDecoder().decode(fileIdBytes);
  offset += fileIdLen;

  const chunkIndex = view.getUint32(offset, true); // Little-endian
  offset += 4;

  const chunkPayload = chunkData.slice(offset);

  const file = incomingFiles[fileId];
  if (!file) {
    console.warn(`Received chunk for unknown fileId: ${fileId}`);
    return;
  }

  if (file.receivedChunks.has(chunkIndex)) {
    // console.log(`Chunk ${chunkIndex} for ${fileId} already received.`);
    // Still send ACK if received, as the sender might not have gotten the previous ACK
    sendChunkAck(fileId, chunkIndex, peerId);
    return;
  }

  file.receivedChunks.set(chunkIndex, chunkPayload);
  file.receivedSize += chunkPayload.byteLength;
  file.progress = (file.receivedSize / file.size) * 100;

  // Ensure progress doesn't exceed 100
  if (file.progress > 100) file.progress = 100;

  // Send ACK for the received chunk
  sendChunkAck(fileId, chunkIndex, peerId);

  // Check if all chunks are received for this file
  if (file.receivedSize >= file.size && file.receivedChunks.size === file.totalChunks) {
    finalizeIncomingFile(fileId, peerId);
  }
};

const sendChunkAck = (fileId, chunkIndex, peerId) => {
  const ackMsg = {
    type: 'chunk-ack',
    fileId,
    chunkIndex
  };
  const dc = peerConnections[peerId]?.dataChannel;
  if (dc?.readyState === 'open') {
    try {
      dc.send(JSON.stringify(ackMsg));
      // console.log(`Sent ACK for chunk ${chunkIndex} of ${fileId} to ${peerId}`);
    } catch (e) {
      console.error('Error sending ACK:', e);
    }
  }
};

const handleChunkAck = (fileId, chunkIndex, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer) {
    transfer.ackedChunks.add(chunkIndex);
    transfer.pendingAcks.delete(chunkIndex); // Remove from pending Acks
    // console.log(`ACK received for chunk ${chunkIndex} of ${fileId} from ${peerId}`);
    // Immediately try to send more if ACK frees up a slot
    processOutgoingQueue(peerId);
  }
};

const finalizeIncomingFile = (fileId, peerId) => {
  const file = incomingFiles[fileId];
  if (!file || file.url) {
    // Already finalized or not found
    return;
  }

  // Verify all chunks received
  if (file.receivedChunks.size < file.totalChunks || file.receivedSize < file.size) {
    console.warn(`Attempted to finalize file ${file.name} but not all chunks received yet. Received: ${file.receivedChunks.size}/${file.totalChunks}`);
    return;
  }

  // Reconstruct the file
  const sortedChunks = [];
  for (let i = 0; i < file.totalChunks; i++) {
    const chunk = file.receivedChunks.get(i);
    if (!chunk) {
      console.error(`Missing chunk ${i} for file ${file.name}. Cannot finalize.`);
      // Potentially clear and restart transfer or mark as failed
      return;
    }
    sortedChunks.push(chunk);
  }

  const blob = new Blob(sortedChunks, { type: file.type });
  file.url = URL.createObjectURL(blob);
  file.progress = 100; // Ensure 100% on completion

  console.log(`File ${file.name} (${file.id}) successfully received and reassembled from ${peerId}.`);

  // Clean up: For a multi-peer broadcast scenario, you might keep the incomingFile entry
  // until all expected transfers are done, but for now, we finalize on first complete.
  // delete incomingFiles[fileId]; // Keep it to allow download
};

// --- Lifecycle Hooks ---
onMounted(() => {
  connectWebSocket();
  startRetransmissionTimer();
});

onUnmounted(() => {
  stopHeartbeat();
  stopRetransmissionTimer();
  if (ws.value) ws.value.close();
  Object.keys(peerConnections).forEach(closePeerConnection);
  // Revoke any created object URLs to free up memory
  receivedFiles.forEach(file => {
    if (file.url) URL.revokeObjectURL(file.url);
  });
});
</script>

<style scoped>
/* Your existing CSS can remain here */
.webrtc-file-transfer-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.connection-info {
  background: #f5f7fa;
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 20px;
}

.file-transfer-section,
.received-files-section {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  margin-bottom: 20px;
}

.progress-container,
.file-progress {
  height: 25px;
  background: #e9ecef;
  border-radius: 4px;
  margin: 10px 0;
  position: relative;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #4facfe 0%, #00f2fe 100%);
  transition: width 0.3s ease;
}

.progress-text,
.speed-indicator {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  color: #495057;
}

.progress-text {
  left: 10px;
}

.speed-indicator {
  right: 10px;
}

.file-item {
  margin-bottom: 15px;
}

.file-header {
  display: flex;
  align-items: center;
  margin-bottom: 5px;
}

.file-name {
  flex: 1;
  font-weight: 500;
}

.file-size {
  margin: 0 10px;
  color: #6c757d;
}

.download-btn {
  padding: 3px 10px;
  background: #28a745;
  color: white;
  border-radius: 4px;
  text-decoration: none;
  font-size: 14px;
}

.connected {
  color: #28a745;
  font-weight: bold;
}

.connecting {
  color: #ffc107;
  font-weight: bold;
}

.disconnected {
  color: #dc3545;
  font-weight: bold;
}

.error-message {
  color: #dc3545;
  margin-top: 10px;
}
</style>