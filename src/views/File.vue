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
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'; // Added nextTick

// --- Configuration Constants ---
const WS_URL = 'ws://59.110.35.198/wgk/ws/file';
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }];
const CHUNK_SIZE = 64 * 1024; // Smaller chunks (e.g., 64KB-256KB) can be more responsive to congestion
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // Increased to 16MB. This is crucial for speed.
const RETRANSMIT_TIMEOUT = 2000; // 2 seconds for retransmission timeout (increased)
const MAX_RETRANSMITS = 10; // Max retries for a chunk (increased)
const HEARTBEAT_INTERVAL = 25000;
const UI_UPDATE_INTERVAL = 100; // Update UI every 100ms

// --- Reactive State ---
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const errorMessage = ref('');
const isTransferring = ref(false);

// Map to store RTCPeerConnection instances, keyed by peerId
const peerConnections = reactive({});

// Stores ongoing outgoing file transfers
// { fileId: { file, totalChunks, sentChunks, ackedChunks, pendingAcks, peers: { peerId: { reader, readerBusy, readerQueue: [], isPeerComplete, ... } }, isComplete, resolve, reject } }
const outgoingTransfers = reactive({});

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

const activePeersCount = computed(() => {
  return Object.values(peerConnections).filter(pc =>
    pc.status === 'connected' && pc.dataChannel?.readyState === 'open'
  ).length;
});


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

let uiUpdateTimer = null;
const startUiUpdateTimer = () => {
  if (uiUpdateTimer) clearInterval(uiUpdateTimer);
  uiUpdateTimer = setInterval(updateSendProgress, UI_UPDATE_INTERVAL);
};

const stopUiUpdateTimer = () => {
  if (uiUpdateTimer) {
    clearInterval(uiUpdateTimer);
    uiUpdateTimer = null;
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
    Object.keys(peerConnections).forEach(closePeerConnection); // Clear all peer connections
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
      // Always create PC for new peers, regardless of who offers
      createPeerConnection(peerId);
      if (mySessionId.value < peerId) { // This peer initiates the offer
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
    // For file sending, we manage per-peer state within outgoingTransfers
  };

  // Setup Data Channel for sending (created by the offerer)
  const dataChannel = pc.createDataChannel('file-transfer-channel', {
    ordered: true, // Guarantees order
    maxRetransmits: 0 // Rely on application-level ACKs for reliability
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
      // No need to process queue here, dc.onopen will handle it
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

const closePeerConnection = (peerId) => {
  if (!peerConnections[peerId]) return;

  console.log(`Closing PeerConnection with ${peerId}`);
  const { pc, dataChannel } = peerConnections[peerId];

  // Abort any ongoing file reads for this peer
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (transfer.peers[peerId]) {
      // Mark this peer as disconnected for the transfer
      transfer.peers[peerId].isPeerComplete = true; // No more sending to this peer
      // Abort any pending FileReader operations for this specific peer
      if (transfer.peers[peerId].readerBusy) {
        transfer.peers[peerId].reader.abort();
      }
      // Clean up its queue
      transfer.peers[peerId].readerQueue.length = 0;
    }
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

  // After closing, check if any broadcast transfer has no more active peers
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    const activePeersForTransfer = Object.keys(transfer.peers).filter(pId =>
      peerConnections[pId] && peerConnections[pId].status === 'connected' && !transfer.peers[pId].isPeerComplete
    );
    if (activePeersForTransfer.length === 0 && !transfer.isComplete) {
      // If no more active peers and transfer not marked complete, assume failure/stop
      transfer.reject(new Error(`All connected peers for transfer ${fileId} disconnected.`));
      transfer.isComplete = true;
    }
  }
};

const setupDataChannel = (dc, peerId) => {
  dc.onopen = () => {
    console.log(`DataChannel to ${peerId} opened!`);
    if (peerConnections[peerId]) {
      peerConnections[peerId].status = 'connected';
      // Process outgoing queue for ALL active transfers to this newly opened DC
      for (const fileId in outgoingTransfers) {
        processOutgoingQueue(fileId, peerId);
      }
    }
  };

  dc.onclose = () => {
    console.log(`DataChannel to ${peerId} closed.`);
    // The closePeerConnection handles broader cleanup
    // peerConnections[peerId].dataChannel = null; // Mark as null directly
  };

  dc.onerror = (error) => {
    console.error(`DataChannel error with ${peerId}:`, error);
    // Optionally close PC on serious DC errors
    closePeerConnection(peerId);
  };

  dc.onbufferedamountlow = () => {
    // console.log(`DataChannel buffered amount low for ${peerId}`);
    // When buffer drains, try to send more for all active transfers
    for (const fileId in outgoingTransfers) {
      processOutgoingQueue(fileId, peerId);
    }
  };

  dc.onmessage = (event) => {
    handleReceivedData(event.data, peerId);
  };
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
    // Add a small delay for addIceCandidate if it's too fast, though typically not needed
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    // console.log(`Added ICE candidate from ${peerId}`);
  } catch (error) {
    if (!error.message.includes('already added') && !error.message.includes('closed')) {
      console.error(`Failed to add ICE candidate from ${peerId}:`, error);
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

  if (chunkData) { // If chunkData is provided (for retransmission)
    const packet = new Uint8Array(header.length + chunkData.byteLength);
    packet.set(header, 0);
    packet.set(new Uint8Array(chunkData), header.length); // Actual chunk data
    return packet.buffer;
  }
  // Return header only initially, actual chunk data added by FileReader
  return header.buffer;
};

const sendCompletionMessage = (dc, fileId) => {
  const completionMsg = {
    type: 'file-transfer-complete',
    fileId: fileId
  };
  try {
    dc.send(JSON.stringify(completionMsg));
  } catch (e) {
    console.error('Error sending completion message:', e);
  }
};

const checkOverallTransferCompletion = (fileId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const allPeersComplete = Object.values(transfer.peers).every(p => p.isPeerComplete);
  if (allPeersComplete) {
    transfer.isComplete = true;
    if (transfer.resolve) transfer.resolve();
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
        // Only retransmit if no ACK received AND the chunk is not currently being read by a FileReader for any peer.
        // This prevents conflicting reads.
        const isBeingReadByAnyPeer = Object.values(transfer.peers).some(peerTransfer =>
          peerTransfer.readerBusy && peerTransfer.readerQueue[0]?.chunkIndex === chunkIndex
        );

        if (Date.now() - item.timestamp > RETRANSMIT_TIMEOUT && !isBeingReadByAnyPeer) {
          if (item.retries < MAX_RETRANSMITS) {
            // console.warn(`Retransmitting chunk ${chunkIndex} for ${fileId} (retry ${item.retries + 1})`);
            // Find an open data channel to send it
            for (const peerId in transfer.peers) {
              const peer = peerConnections[peerId];
              const dc = peer?.dataChannel;
              if (dc?.readyState === 'open' && !transfer.peers[peerId].isPeerComplete) {
                if (dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
                  try {
                    dc.send(item.data); // Resend the original packet with data
                    item.timestamp = Date.now(); // Reset timestamp
                    item.retries++;
                    return; // Only retransmit once per timeout, then check next chunk
                  } catch (e) {
                    console.error(`Error retransmitting chunk ${chunkIndex} to ${peerId}:`, e);
                    // If send fails, potentially mark peer as problematic
                  }
                }
              }
            }
          } else {
            console.error(`Max retransmits reached for chunk ${chunkIndex} of ${fileId}. Transfer failed for this chunk.`);
            transfer.pendingAcks.delete(chunkIndex); // Remove from pending
            // This chunk will now be permanently missing for the receiver if not acked.
            // If this is a critical file, you might want to reject the whole transfer:
            // if (transfer.reject) transfer.reject(new Error(`Max retransmits for chunk ${chunkIndex} reached.`));
            // transfer.isComplete = true; // Stop further processing for this file
          }
        }
      });
    }
    // If no active transfers, stop the timer
    if (Object.keys(outgoingTransfers).length === 0 && !isTransferring.value) { // Also check isTransferring flag
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
  // Speed calculation
  const timeDiffSeconds = (now - lastSpeedCalcTime.value) / 1000;
  if (timeDiffSeconds >= (UI_UPDATE_INTERVAL / 1000)) { // Update speed based on UI_UPDATE_INTERVAL
    const bytesDiff = totalBytesSent.value - lastBytesSentForSpeed.value;
    currentSendSpeed.value = bytesDiff / timeDiffSeconds;
    lastBytesSentForSpeed.value = totalBytesSent.value;
    lastSpeedCalcTime.value = now;
  }

  // Progress calculation
  if (selectedFile.value && selectedFile.value.size > 0 && Object.keys(outgoingTransfers).length > 0) {
    let completedChunksCount = 0;
    let totalExpectedChunks = 0;

    // For the currently active transfer (assuming only one broadcast at a time)
    // Find the primary transfer associated with selectedFile
    const currentFileTransfer = Object.values(outgoingTransfers).find(t => t.file.name === selectedFile.value.name);

    if (currentFileTransfer) {
      completedChunksCount = currentFileTransfer.ackedChunks.size;
      totalExpectedChunks = currentFileTransfer.totalChunks;

      if (totalExpectedChunks > 0) {
        sendProgress.value = (completedChunksCount / totalExpectedChunks) * 100;
        if (sendProgress.value > 100) sendProgress.value = 100;
      } else {
        sendProgress.value = 0;
      }
    } else {
      sendProgress.value = 0; // No active transfer for the selected file
    }
  } else {
    sendProgress.value = 0; // No file selected or no active transfers
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
        finalizeIncomingFile(msg.fileId, peerId); // Finalize, or mark as complete if not fully received
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
    return; // Already initialized, possibly redundant metadata
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
    peerSource: peerId // Keep track of which peer sent this file initially
  });
  incomingFiles[fileId] = newIncomingFile;

  // Add to UI list if not already there (multiple peers might send same file)
  const existingUiFile = receivedFiles.find(f => f.id === fileId);
  if (!existingUiFile) {
    receivedFiles.push(newIncomingFile);
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
      // console.error(`Error sending ACK for chunk ${chunkIndex} to ${peerId}:`, e);
      // If ACK fails, the sender will retransmit.
    }
  }
};

const handleChunkAck = (fileId, chunkIndex, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer) {
    if (!transfer.ackedChunks.has(chunkIndex)) { // Only if this is a new ACK
      transfer.ackedChunks.add(chunkIndex);
      transfer.pendingAcks.delete(chunkIndex); // Remove from pending Acks
      // console.log(`ACK received for chunk ${chunkIndex} of ${fileId} from ${peerId}`);
      // Immediately try to send more if ACK frees up a slot
      processOutgoingQueue(fileId, peerId);
    }
  }
};



// --- Lifecycle Hooks ---
onMounted(() => {
  connectWebSocket();
  startRetransmissionTimer();
});

onUnmounted(() => {
  stopHeartbeat();
  stopRetransmissionTimer();
  stopUiUpdateTimer();
  if (ws.value) ws.value.close();
  Object.keys(peerConnections).forEach(closePeerConnection);
  // Revoke any created object URLs to free up memory
  receivedFiles.forEach(file => {
    if (file.url) URL.revokeObjectURL(file.url);
  });
});













const sendMetaData = (dc, fileId, name, size, type) => {
  const metadata = {
    type: 'file-metadata',
    fileId: fileId,
    name: name,
    size: size,
    fileType: type,
    chunkSize: CHUNK_SIZE // Inform receiver about chunk size
  };
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`Sent metadata for file ${fileId} (${name}) to peer via DataChannel.`);
  } catch (e) {
    console.error('Error sending metadata:', e);
  }
};


const handleFileSelection = (event) => {
  selectedFile.value = event.target.files[0];
  errorMessage.value = '';
  sendProgress.value = 0;
  totalBytesSent.value = 0;
  currentSendSpeed.value = 0;
  isTransferring.value = false;
  // Clear any existing transfers if a new file is selected
  for(const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if(!transfer.isComplete && transfer.reject) {
      transfer.reject(new Error('New file selected, transfer cancelled.'));
    }
    delete outgoingTransfers[fileId];
  }
};

const startFileTransfer = async () => {
  if (!selectedFile.value) {
    errorMessage.value = '请先选择文件！';
    return;
  }
  const activePeers = Object.keys(peerConnections).filter(id => peerConnections[id].status === 'connected' && peerConnections[id].dataChannel?.readyState === 'open');

  if (activePeers.length === 0) {
    errorMessage.value = '没有可用的对等连接！';
    isTransferring.value = false; // Reset if no peers
    return;
  }

  isTransferring.value = true;
  errorMessage.value = '';
  totalBytesSent.value = 0;
  lastSpeedCalcTime.value = Date.now();
  lastBytesSentForSpeed.value = 0;
  currentSendSpeed.value = 0;
  sendProgress.value = 0;
  startUiUpdateTimer(); // Start UI update timer

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
    peers: {}, // { peerId: { reader, readerBusy, readerQueue: [], isPeerComplete, ... } }
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
    const peerTransfer = {
      reader: new FileReader(), // Dedicated FileReader per peer
      readerBusy: false,
      // readerQueue 将只存储 { chunkIndex, originalSliceSize }，不存储不完整的 packet
      readerQueue: [], // Queue for chunks to be read by this peer's FileReader
      isPeerComplete: false,
      lastAckTime: Date.now() // For peer health check (optional)
    };
    outgoingTransfers[fileId].peers[peerId] = peerTransfer;

    // Set up FileReader handlers once
    peerTransfer.reader.onload = (e) => {
      peerTransfer.readerBusy = false;
      // 从队列中取出对应的块信息（不再有 `packet` 字段）
      const { chunkIndex, originalSliceSize } = peerTransfer.readerQueue.shift();

      // FileReader 读取到的实际 ArrayBuffer 数据
      const chunkDataArrayBuffer = e.target.result;

      // ****** 核心改动在这里：使用真实的 chunkDataArrayBuffer 来构建完整的包 ******
      const fullPacket = createDataPacket(transfer.fileId, chunkIndex, chunkDataArrayBuffer);

      const dc = peerConnections[peerId]?.dataChannel;
      if (dc?.readyState === 'open' && dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
        try {
          dc.send(fullPacket); // 发送包含实际数据的完整包
          // console.log(`Sent chunk ${chunkIndex} for file ${fileId} to ${peerId} (size: ${chunkDataArrayBuffer.byteLength})`);

          outgoingTransfers[fileId].sentChunks.add(chunkIndex);
          outgoingTransfers[fileId].pendingAcks.set(chunkIndex, {
            timestamp: Date.now(),
            retries: 0,
            data: fullPacket // 重传时也使用完整包
          });
          // 仅在成功发送到 DataChannel 缓冲区后才更新发送字节数，更准确反映网络吞吐
          totalBytesSent.value += originalSliceSize;

        } catch (sendError) {
          console.error(`Error sending chunk ${chunkIndex} to ${peerId}:`, sendError);
          // 如果 DataChannel 发生错误，关闭 PeerConnection，触发清理
          closePeerConnection(peerId);
        }
      } else {
        // 如果 DataChannel 未打开或缓冲区已满，无法立即发送。
        // 这个 chunk 已经读取但尚未发送，它会在下一次 processOutgoingQueue 尝试时被重新处理。
        console.warn(`DataChannel not ready or buffer full for ${peerId} after reading chunk ${chunkIndex}. This chunk might be delayed.`);
      }
      processOutgoingQueue(fileId, peerId); // 尝试读取下一个分块或处理待发队列
    };

    peerTransfer.reader.onerror = (e) => {
      peerTransfer.readerBusy = false;
      console.error(`FileReader error for ${peerId}:`, e.target.error);
      peerTransfer.isPeerComplete = true; // 标记此 peer 的传输已完成（因错误）
      errorMessage.value = `文件读取失败: ${e.target.error.message}`;
      if (outgoingTransfers[fileId].reject) outgoingTransfers[fileId].reject(e.target.error);
      outgoingTransfers[fileId].isComplete = true; // 标记整个文件传输失败
    };

    // Send initial metadata
    const dc = peerConnections[peerId]?.dataChannel;
    if (dc?.readyState === 'open') {
      sendMetaData(dc, fileId, file.name, file.size, file.type || 'application/octet-stream');
      // 首次连接时，尝试启动数据发送
      processOutgoingQueue(fileId, peerId);
    } else {
      console.log(`DC not open for ${peerId}, metadata and chunks will be sent when DC opens.`);
    }
  });

  try {
    await transferPromise;
    console.log('File transfer completed successfully!');
    errorMessage.value = ''; // Clear any previous errors
    sendProgress.value = 100;
  } catch (error) {
    console.error('File transfer failed:', error);
    errorMessage.value = `文件传输失败: ${error.message}`;
    // Keep progress at current state or reset based on UX choice
  } finally {
    isTransferring.value = false;
    stopUiUpdateTimer();
    // 只在新的文件传输开始或手动清理时才删除 transfer 对象
    // delete outgoingTransfers[fileId]; // 暂时不在这里删除，以防需要检查状态
  }
};

// Process the outgoing queue for a specific file and peer
const processOutgoingQueue = (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const peerTransfer = transfer.peers[peerId];
  if (!peerTransfer || peerTransfer.isPeerComplete) return;

  const peerConn = peerConnections[peerId];
  const dc = peerConn?.dataChannel;

  if (!dc || dc.readyState !== 'open') {
    // console.log(`DataChannel to ${peerId} not open, cannot send.`);
    return;
  }

  // --- 1. Check for space in DataChannel buffer ---
  // 只有当缓冲区有空间且 FileReader 不忙时才继续
  if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    // console.log(`Buffered amount for ${peerId} is high: ${formatBytes(dc.bufferedAmount)}`);
    return; // 等待 onbufferedamountlow 事件
  }

  // --- 2. 尝试喂给 FileReader 队列（如果它不忙） ---
  if (!peerTransfer.readerBusy && peerTransfer.readerQueue.length === 0) {
    // 找到下一个尚未被确认且当前没有正在被发送的块
    let nextChunkIndex = -1;
    for (let i = 0; i < transfer.totalChunks; i++) {
      // 检查：1. 尚未被接收端确认； 2. 尚未处于待确认状态（即尚未发送）
      if (!transfer.ackedChunks.has(i) && !transfer.pendingAcks.has(i)) {
        nextChunkIndex = i;
        break;
      }
    }

    if (nextChunkIndex !== -1) {
      const start = nextChunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
      const slice = transfer.file.slice(start, end);

      // ****** 核心改动在这里：只推送 chunkIndex 和 originalSliceSize ******
      peerTransfer.readerQueue.push({ chunkIndex: nextChunkIndex, originalSliceSize: slice.size });

      peerTransfer.readerBusy = true;
      peerTransfer.reader.readAsArrayBuffer(slice); // 异步读取文件切片
      // console.log(`Queued chunk ${nextChunkIndex} for FileReader of ${peerId}`);
      return; // 立即返回，等待 FileReader.onload 回调完成后再继续处理
    }
  }

  // --- 3. 检查是否完成 ---
  // 如果所有分块都已发送并被此对等端确认，则标记此对等端传输完成
  if (transfer.ackedChunks.size === transfer.totalChunks && !peerTransfer.isPeerComplete) {
    sendCompletionMessage(dc, fileId);
    peerTransfer.isPeerComplete = true;
    console.log(`File ${fileId} transfer completed for peer ${peerId}`);
    // 检查整体传输是否对所有对等端都已完成
    checkOverallTransferCompletion(fileId);
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

  const chunkPayload = chunkData.slice(offset); // The actual chunk data

  const file = incomingFiles[fileId];
  if (!file) {
    console.warn(`Received chunk ${chunkIndex} for unknown fileId: ${fileId}. Requesting metadata.`);
    // Optionally request metadata from sender if this happens often:
    // sendWsMessage('request-metadata', { fileId }, peerId);
    return;
  }

  // If already received this chunk, just ACK again (sender might retransmit)
  if (file.receivedChunks.has(chunkIndex)) {
    // console.log(`Chunk ${chunkIndex} for ${fileId} already received. Re-ACKing.`);
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
  // IMPORTANT: Use >= for receivedSize check to account for potential byte-level differences
  if (file.receivedChunks.size === file.totalChunks && file.receivedSize >= file.size) {
      finalizeIncomingFile(fileId, peerId);
  }
};


const finalizeIncomingFile = (fileId, peerId) => {
  const file = incomingFiles[fileId];
  if (!file || file.url) {
    // Already finalized or not found
    return;
  }

  // Validate that we indeed have all chunks, and received size matches total size
  // This check is slightly relaxed to allow for minor calculation discrepancies
  const expectedTotalBytes = file.size;
  const actualReceivedBytes = Array.from(file.receivedChunks.values()).reduce((sum, chunk) => sum + chunk.byteLength, 0);

  if (file.receivedChunks.size !== file.totalChunks || actualReceivedBytes < expectedTotalBytes) {
      console.warn(`Attempted to finalize file ${file.name} but not all chunks received or size mismatch.
      Received chunks count: ${file.receivedChunks.size}/${file.totalChunks},
      Received bytes: ${actualReceivedBytes}/${expectedTotalBytes}.`);
      errorMessage.value = `文件接收不完整：分块数量或大小不匹配。`;
      return; // Stop if critical chunk is missing or size mismatch
  }


  // Reconstruct the file
  const sortedChunks = [];
  for (let i = 0; i < file.totalChunks; i++) {
    const chunk = file.receivedChunks.get(i);
    if (!chunk) {
      console.error(`CRITICAL: Missing chunk ${i} for file ${file.name}. Cannot finalize.`);
      errorMessage.value = `文件接收不完整：缺少分块 ${i}。`;
      return; // Stop if critical chunk is missing
    }
    sortedChunks.push(chunk);
  }

  const blob = new Blob(sortedChunks, { type: file.type });
  file.url = URL.createObjectURL(blob);
  file.progress = 100; // Ensure 100% on completion

  console.log(`File ${file.name} (${file.id}) successfully received and reassembled from ${peerId}.`);

  // Optionally revoke previous URLs if the file is updated or re-received
  // For simplicity, we just create a new one.
};
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