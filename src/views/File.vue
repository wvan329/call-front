<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC 文件传输</h2>

    <!-- <div class="connection-info">
      <h3>连接状态</h3>
      <p>我的会话ID: <span class="my-id">{{ mySessionId || '未连接' }}</span></p>
      <p>WebSocket 状态:
        <span :class="wsStatus.class">{{ wsStatus.text }}</span>
      </p>
      <p>在线数: <span class="connected-peers-count">{{ activePeersCount }}</span></p>
      <p>传输速度: <span class="transfer-speed">{{ formatSpeed(currentSendSpeed) }}</span></p>
      <p v-if="adaptiveInfo.enabled">动态速率控制:
        <span class="adaptive-info">
          阻塞率: {{ (adaptiveInfo.congestionRate * 100).toFixed(1) }}% |
          动态块大小: {{ formatBytes(adaptiveInfo.currentChunkSize) }}
        </span>
      </p>
    </div> -->

    <div class="file-transfer-section">
      <h3>文件发送</h3>
      <input type="file" @change="handleFileSelection" ref="fileInput" />
      <button @click="startFileTransfer" :disabled="!selectedFile || activePeersCount === 0 || isTransferring">
        {{ isTransferring ? '正在发送...' : '极速广播文件' }}
      </button>
      <div v-if="selectedFile" class="file-info">
        <p>已选文件: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
        <p>基础分块大小: {{ formatBytes(BASE_CHUNK_SIZE) }}</p>
      </div>
      <div class="progress-container" v-if="selectedFile">
        <div class="progress-bar" :style="{ width: sendProgress + '%' }"></div>
        <span class="progress-text">{{ sendProgress.toFixed(1) }}%</span>
        <span class="speed-indicator">{{ formatSpeed(currentSendSpeed) }}/s</span>
      </div>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
      <!-- <div v-if="transferStats.enabled" class="transfer-stats">
        <p>重传次数: {{ transferStats.retransmissions }}</p>
        <p>丢包率: {{ (transferStats.packetLossRate * 100).toFixed(2) }}%</p>
        <p>平均RTT: {{ transferStats.averageRTT }}ms</p>
      </div> -->
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
      <!-- <p v-else class="empty-message">暂无接收文件</p> -->
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';

// --- Enhanced Configuration Constants ---
const WS_URL = 'ws://59.110.35.198/wgk/ws/file';
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }];
const BASE_CHUNK_SIZE = 32 * 1024; // Start with 32KB chunks
const MIN_CHUNK_SIZE = 8 * 1024;   // Minimum 8KB
const MAX_CHUNK_SIZE = 256 * 1024; // Maximum 256KB
const INITIAL_BUFFER_LIMIT = 4 * 1024 * 1024; // Start with 4MB buffer
const MIN_BUFFER_LIMIT = 1 * 1024 * 1024;     // Minimum 1MB
const MAX_BUFFER_LIMIT = 32 * 1024 * 1024;    // Maximum 32MB
const RETRANSMIT_TIMEOUT = 3000;
const MAX_RETRANSMITS = 50;
const HEARTBEAT_INTERVAL = 25000;
const UI_UPDATE_INTERVAL = 200;
const CONGESTION_DETECTION_WINDOW = 10; // Monitor last 10 chunks for congestion
const ADAPTIVE_ADJUSTMENT_INTERVAL = 1000; // Adjust parameters every second

// --- Reactive State ---
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const errorMessage = ref('');
const isTransferring = ref(false);

// Enhanced peer connection management
const peerConnections = reactive({});
const outgoingTransfers = reactive({});
const incomingFiles = reactive({});

// Enhanced performance tracking
const totalBytesSent = ref(0);
const lastSpeedCalcTime = ref(0);
const lastBytesSentForSpeed = ref(0);
const currentSendSpeed = ref(0);
const sendProgress = ref(0);
const receivedFiles = reactive([]);

// Adaptive rate control
const adaptiveInfo = reactive({
  enabled: false,
  currentChunkSize: BASE_CHUNK_SIZE,
  currentBufferLimit: INITIAL_BUFFER_LIMIT,
  congestionRate: 0,
  recentSendTimes: [],
  recentBufferFullEvents: 0,
  lastAdjustmentTime: 0
});

// Transfer statistics
const transferStats = reactive({
  enabled: false,
  retransmissions: 0,
  totalPacketsSent: 0,
  packetLossRate: 0,
  rttMeasurements: [],
  averageRTT: 0
});

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

// --- Enhanced Utility Functions ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
};

const formatSpeed = (bytes) => {
  return formatBytes(bytes);
};

const generateUniqueId = () => {
  return `${mySessionId.value}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// --- Adaptive Rate Control Functions ---
const updateCongestionMetrics = (sendTime, wasBufferFull) => {
  const now = Date.now();
  adaptiveInfo.recentSendTimes.push({ time: now, sendTime });

  if (wasBufferFull) {
    adaptiveInfo.recentBufferFullEvents++;
  }

  // Keep only recent data (last 10 seconds)
  const cutoffTime = now - 10000;
  adaptiveInfo.recentSendTimes = adaptiveInfo.recentSendTimes.filter(entry => entry.time > cutoffTime);

  // Calculate congestion rate
  if (adaptiveInfo.recentSendTimes.length > 0) {
    const bufferFullRate = adaptiveInfo.recentBufferFullEvents / adaptiveInfo.recentSendTimes.length;
    adaptiveInfo.congestionRate = Math.min(bufferFullRate, 1.0);
  }

  // Reset buffer full events counter periodically
  if (now - adaptiveInfo.lastAdjustmentTime > 5000) {
    adaptiveInfo.recentBufferFullEvents = 0;
    adaptiveInfo.lastAdjustmentTime = now;
  }
};

const adjustTransferParameters = () => {
  if (!adaptiveInfo.enabled) return;

  const now = Date.now();
  if (now - adaptiveInfo.lastAdjustmentTime < ADAPTIVE_ADJUSTMENT_INTERVAL) return;

  const congestionRate = adaptiveInfo.congestionRate;

  // Adjust chunk size based on congestion
  if (congestionRate > 0.3) {
    // High congestion - reduce chunk size
    adaptiveInfo.currentChunkSize = Math.max(
      MIN_CHUNK_SIZE,
      Math.floor(adaptiveInfo.currentChunkSize * 0.8)
    );
    adaptiveInfo.currentBufferLimit = Math.max(
      MIN_BUFFER_LIMIT,
      Math.floor(adaptiveInfo.currentBufferLimit * 0.9)
    );
  } else if (congestionRate < 0.1) {
    // Low congestion - increase chunk size gradually
    adaptiveInfo.currentChunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.floor(adaptiveInfo.currentChunkSize * 1.1)
    );
    adaptiveInfo.currentBufferLimit = Math.min(
      MAX_BUFFER_LIMIT,
      Math.floor(adaptiveInfo.currentBufferLimit * 1.05)
    );
  }

  adaptiveInfo.lastAdjustmentTime = now;
};

// --- Enhanced File Transfer Logic ---
const handleFileSelection = (event) => {
  selectedFile.value = event.target.files[0];
  errorMessage.value = '';
  sendProgress.value = 0;
  totalBytesSent.value = 0;
  currentSendSpeed.value = 0;
  isTransferring.value = false;

  // Reset adaptive control
  adaptiveInfo.enabled = false;
  adaptiveInfo.currentChunkSize = BASE_CHUNK_SIZE;
  adaptiveInfo.currentBufferLimit = INITIAL_BUFFER_LIMIT;
  adaptiveInfo.congestionRate = 0;
  adaptiveInfo.recentSendTimes = [];
  adaptiveInfo.recentBufferFullEvents = 0;

  // Reset transfer stats
  transferStats.enabled = false;
  transferStats.retransmissions = 0;
  transferStats.totalPacketsSent = 0;
  transferStats.packetLossRate = 0;
  transferStats.rttMeasurements = [];
  transferStats.averageRTT = 0;

  // Clear existing transfers
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (!transfer.isComplete && transfer.reject) {
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

  const activePeers = Object.keys(peerConnections).filter(id =>
    peerConnections[id].status === 'connected' &&
    peerConnections[id].dataChannel?.readyState === 'open'
  );

  if (activePeers.length === 0) {
    errorMessage.value = '没有可用的对等连接！';
    return;
  }

  isTransferring.value = true;
  errorMessage.value = '';
  totalBytesSent.value = 0;
  lastSpeedCalcTime.value = Date.now();
  lastBytesSentForSpeed.value = 0;
  currentSendSpeed.value = 0;
  sendProgress.value = 0;

  // Enable adaptive control and stats
  adaptiveInfo.enabled = true;
  transferStats.enabled = true;

  startUiUpdateTimer();
  startAdaptiveControlTimer();

  const file = selectedFile.value;
  const fileId = generateUniqueId();
  const totalChunks = Math.ceil(file.size / adaptiveInfo.currentChunkSize);

  // Initialize transfer state
  const currentTransfer = {
    file,
    fileId,
    totalChunks,
    sentChunks: new Set(),
    ackedChunks: new Set(),
    pendingAcks: new Map(),
    peers: {},
    transferStartTime: Date.now(),
    isComplete: false,
    resolve: null,
    reject: null,
    chunkSize: adaptiveInfo.currentChunkSize
  };

  outgoingTransfers[fileId] = currentTransfer;

  const transferPromise = new Promise((resolve, reject) => {
    currentTransfer.resolve = resolve;
    currentTransfer.reject = reject;
  });

  // Setup transfer for each peer
  activePeers.forEach(peerId => {
    const peerTransfer = {
      readQueue: [],
      isPeerComplete: false,
      lastAckTime: Date.now(),
      sendInProgress: false,
      consecutiveFailures: 0
    };
    currentTransfer.peers[peerId] = peerTransfer;

    // Send metadata
    const dc = peerConnections[peerId]?.dataChannel;
    if (dc?.readyState === 'open') {
      sendMetaData(dc, fileId, file.name, file.size, file.type || 'application/octet-stream');
      processOutgoingQueue(fileId, peerId);
    }
  });

  try {
    await transferPromise;
    console.log('File transfer completed successfully!');
    errorMessage.value = '';
    sendProgress.value = 100;
  } catch (error) {
    console.error('File transfer failed:', error);
    errorMessage.value = `文件传输失败: ${error.message}`;
  } finally {
    isTransferring.value = false;
    adaptiveInfo.enabled = false;
    transferStats.enabled = false;
    stopUiUpdateTimer();
    stopAdaptiveControlTimer();
  }
};

// --- Enhanced Data Channel Management ---
const createDataPacket = (fileId, chunkIndex, chunkData) => {
  const fileIdBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(1 + fileIdBytes.length + 4 + 8); // Added timestamp

  let offset = 0;
  header[offset++] = fileIdBytes.length;
  header.set(fileIdBytes, offset);
  offset += fileIdBytes.length;

  new DataView(header.buffer).setUint32(offset, chunkIndex, true);
  offset += 4;

  // Add timestamp for RTT measurement
  new DataView(header.buffer).setBigUint64(offset, BigInt(Date.now()), true);

  if (chunkData) {
    const packet = new Uint8Array(header.length + chunkData.byteLength);
    packet.set(header, 0);
    packet.set(new Uint8Array(chunkData), header.length);
    return packet.buffer;
  }

  return header.buffer;
};

const processOutgoingQueue = async (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const peerTransfer = transfer.peers[peerId];
  if (!peerTransfer || peerTransfer.isPeerComplete || peerTransfer.sendInProgress) return;

  const peerConn = peerConnections[peerId];
  const dc = peerConn?.dataChannel;

  if (!dc || dc.readyState !== 'open') return;

  // Enhanced buffer management with adaptive limits
  const currentBufferLimit = adaptiveInfo.enabled ? adaptiveInfo.currentBufferLimit : INITIAL_BUFFER_LIMIT;
  if (dc.bufferedAmount > currentBufferLimit) {
    updateCongestionMetrics(Date.now(), true);
    return;
  }

  peerTransfer.sendInProgress = true;

  try {
    // Find next chunk to send
    let nextChunkIndex = -1;
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.ackedChunks.has(i) && !transfer.pendingAcks.has(i)) {
        nextChunkIndex = i;
        break;
      }
    }

    if (nextChunkIndex !== -1) {
      const currentChunkSize = adaptiveInfo.enabled ? adaptiveInfo.currentChunkSize : BASE_CHUNK_SIZE;
      const start = nextChunkIndex * currentChunkSize;
      const end = Math.min(start + currentChunkSize, transfer.file.size);

      // Use File.slice() and FileReader for better memory management
      const slice = transfer.file.slice(start, end);

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const chunkData = e.target.result;
          const packet = createDataPacket(fileId, nextChunkIndex, chunkData);

          const sendStartTime = Date.now();
          dc.send(packet);

          transfer.sentChunks.add(nextChunkIndex);
          transfer.pendingAcks.set(nextChunkIndex, {
            timestamp: sendStartTime,
            retries: 0,
            data: packet
          });

          transferStats.totalPacketsSent++;
          totalBytesSent.value += slice.size;

          updateCongestionMetrics(Date.now() - sendStartTime, false);

          // Continue processing queue
          setTimeout(() => {
            peerTransfer.sendInProgress = false;
            processOutgoingQueue(fileId, peerId);
          }, 1); // Small delay to prevent blocking

        } catch (sendError) {
          console.error(`Error sending chunk ${nextChunkIndex} to ${peerId}:`, sendError);
          peerTransfer.consecutiveFailures++;
          if (peerTransfer.consecutiveFailures > 5) {
            console.warn(`Too many failures for peer ${peerId}, closing connection`);
            closePeerConnection(peerId);
          }
          peerTransfer.sendInProgress = false;
        }
      };

      reader.onerror = (e) => {
        console.error(`FileReader error for chunk ${nextChunkIndex}:`, e.target.error);
        peerTransfer.sendInProgress = false;
      };

      reader.readAsArrayBuffer(slice);
    } else {
      peerTransfer.sendInProgress = false;
      // Check if transfer is complete
      if (transfer.ackedChunks.size === transfer.totalChunks && !peerTransfer.isPeerComplete) {
        sendCompletionMessage(dc, fileId);
        peerTransfer.isPeerComplete = true;
        checkOverallTransferCompletion(fileId);
      }
    }
  } catch (error) {
    console.error(`Error in processOutgoingQueue for ${peerId}:`, error);
    peerTransfer.sendInProgress = false;
    peerTransfer.consecutiveFailures++;
  }
};

// --- WebSocket and WebRTC Management (keeping existing logic but enhanced error handling) ---
const sendWsMessage = (type, data = {}, to = null) => {
  if (ws.value?.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not open, cannot send message:', type);
    return;
  }
  try {
    const message = { type, ...data };
    if (to) message.to = to;
    ws.value.send(JSON.stringify(message));
  } catch (error) {
    console.error('Error sending WebSocket message:', error);
  }
};

const sendMetaData = (dc, fileId, name, size, type) => {
  const metadata = {
    type: 'file-metadata',
    fileId: fileId,
    name: name,
    size: size,
    fileType: type,
    chunkSize: adaptiveInfo.currentChunkSize
  };
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`Sent metadata for file ${fileId} (${name}) to peer via DataChannel.`);
  } catch (e) {
    console.error('Error sending metadata:', e);
  }
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

const handleChunkAck = (fileId, chunkIndex, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer && !transfer.ackedChunks.has(chunkIndex)) {
    const pendingAck = transfer.pendingAcks.get(chunkIndex);
    if (pendingAck) {
      // Calculate RTT
      const rtt = Date.now() - pendingAck.timestamp;
      transferStats.rttMeasurements.push(rtt);
      if (transferStats.rttMeasurements.length > 100) {
        transferStats.rttMeasurements.shift(); // Keep last 100 measurements
      }
      transferStats.averageRTT = Math.round(
        transferStats.rttMeasurements.reduce((a, b) => a + b, 0) / transferStats.rttMeasurements.length
      );
    }

    transfer.ackedChunks.add(chunkIndex);
    transfer.pendingAcks.delete(chunkIndex);

    // Reset consecutive failures for this peer
    if (transfer.peers[peerId]) {
      transfer.peers[peerId].consecutiveFailures = 0;
    }

    processOutgoingQueue(fileId, peerId);
  }
};

// --- Timer Management ---
let uiUpdateTimer = null;
let adaptiveControlTimer = null;
let retransmissionTimer = null;

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

const startAdaptiveControlTimer = () => {
  if (adaptiveControlTimer) clearInterval(adaptiveControlTimer);
  adaptiveControlTimer = setInterval(adjustTransferParameters, ADAPTIVE_ADJUSTMENT_INTERVAL);
};

const stopAdaptiveControlTimer = () => {
  if (adaptiveControlTimer) {
    clearInterval(adaptiveControlTimer);
    adaptiveControlTimer = null;
  }
};

const startRetransmissionTimer = () => {
  if (retransmissionTimer) return;
  retransmissionTimer = setInterval(() => {
    for (const fileId in outgoingTransfers) {
      const transfer = outgoingTransfers[fileId];
      if (transfer.isComplete) continue;

      transfer.pendingAcks.forEach((item, chunkIndex) => {
        if (Date.now() - item.timestamp > RETRANSMIT_TIMEOUT) {
          if (item.retries < MAX_RETRANSMITS) {
            // Find an active peer to retransmit
            for (const peerId in transfer.peers) {
              const peer = peerConnections[peerId];
              const dc = peer?.dataChannel;
              if (dc?.readyState === 'open' && !transfer.peers[peerId].isPeerComplete) {
                const currentBufferLimit = adaptiveInfo.enabled ? adaptiveInfo.currentBufferLimit : INITIAL_BUFFER_LIMIT;
                if (dc.bufferedAmount < currentBufferLimit) {
                  try {
                    dc.send(item.data);
                    item.timestamp = Date.now();
                    item.retries++;
                    transferStats.retransmissions++;

                    // Update packet loss rate
                    transferStats.packetLossRate = transferStats.retransmissions / Math.max(transferStats.totalPacketsSent, 1);

                    return; // Only retransmit once per timeout
                  } catch (e) {
                    console.error(`Error retransmitting chunk ${chunkIndex} to ${peerId}:`, e);
                  }
                }
              }
            }
          } else {
            console.error(`Max retransmits reached for chunk ${chunkIndex} of ${fileId}`);
            transfer.pendingAcks.delete(chunkIndex);
          }
        }
      });
    }
  }, 1000);
};

const stopRetransmissionTimer = () => {
  if (retransmissionTimer) {
    clearInterval(retransmissionTimer);
    retransmissionTimer = null;
  }
};

const updateSendProgress = () => {
  const now = Date.now();
  const timeDiffSeconds = (now - lastSpeedCalcTime.value) / 1000;

  if (timeDiffSeconds >= (UI_UPDATE_INTERVAL / 1000)) {
    const bytesDiff = totalBytesSent.value - lastBytesSentForSpeed.value;
    if (timeDiffSeconds != 0) {
      currentSendSpeed.value = bytesDiff / timeDiffSeconds;
    }
    lastBytesSentForSpeed.value = totalBytesSent.value;
    lastSpeedCalcTime.value = now;
  }

  if (selectedFile.value && selectedFile.value.size > 0 && Object.keys(outgoingTransfers).length > 0) {
    const currentFileTransfer = Object.values(outgoingTransfers).find(t =>
      t.file.name === selectedFile.value.name && !t.isComplete
    );

    if (currentFileTransfer) {
      const completedChunks = currentFileTransfer.ackedChunks.size;
      const totalChunks = currentFileTransfer.totalChunks;

      if (totalChunks > 0) {
        sendProgress.value = Math.min((completedChunks / totalChunks) * 100, 100);
      }
    }
  }
};

// --- WebSocket Connection Management (keeping existing logic but enhanced) ---
let heartbeatIntervalId;

const startHeartbeat = () => {
  stopHeartbeat();
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

const connectWebSocket = () => {
  if (ws.value?.readyState === WebSocket.OPEN || ws.value?.readyState === WebSocket.CONNECTING) return;

  ws.value = new WebSocket(WS_URL);

  ws.value.onopen = () => {
    console.log('WebSocket connection established.');
    startHeartbeat();
    sendWsMessage('get-users');
  };

  ws.value.onmessage = async (event) => {
    if (event.data === 'pong') return;

    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'session-id':
          mySessionId.value = msg.id;
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
          closePeerConnection(msg.from);
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  };

  ws.value.onclose = () => {
    console.log('WebSocket connection closed. Reconnecting...');
    stopHeartbeat();
    Object.keys(peerConnections).forEach(closePeerConnection);
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    console.error('WebSocket error:', error);
    ws.value?.close();
  };
};

const handleUserList = (users) => {
  const onlinePeers = new Set(users.filter(id => id !== mySessionId.value));
  const currentPeers = new Set(Object.keys(peerConnections));

  // 添加新的对等端
  onlinePeers.forEach(peerId => {
    if (!currentPeers.has(peerId)) {
      createPeerConnection(peerId);
      // 只有当前会话ID小于对端ID时才创建Offer，避免重复创建
      if (mySessionId.value < peerId) {
        createOffer(peerId);
      }
    }
  });

  // 移除已离开的对等端
  currentPeers.forEach(peerId => {
    if (!onlinePeers.has(peerId)) {
      closePeerConnection(peerId);
    }
  });
};

// 继续补充 handleSignalingOffer 函数
const handleSignalingOffer = async (sdp, from) => {
  if (!peerConnections[from]) {
    createPeerConnection(from);
  }

  const pc = peerConnections[from].connection;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWsMessage('answer', { sdp: answer, to: from });
  } catch (error) {
    console.error('Error handling signaling offer:', error);
    closePeerConnection(from);
  }
};

// 补充 handleSignalingAnswer 函数
const handleSignalingAnswer = async (sdp, from) => {
  const pc = peerConnections[from]?.connection;
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    console.error('Error handling signaling answer:', error);
    closePeerConnection(from);
  }
};

// 补充 handleSignalingCandidate 函数
const handleSignalingCandidate = async (candidate, from) => {
  const pc = peerConnections[from]?.connection;
  if (!pc) return;

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error('Error handling ICE candidate:', error);
  }
};

// 补充 createPeerConnection 函数
const createPeerConnection = (peerId) => {
  if (peerConnections[peerId]) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[peerId] = {
    connection: pc,
    status: 'connecting',
    dataChannel: null
  };

  // ICE候选者处理
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWsMessage('candidate', { candidate: event.candidate, to: peerId });
    }
  };

  // ICE连接状态变化
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      closePeerConnection(peerId);
    }
  };

  // 创建数据通道（仅当发起连接时）
  if (mySessionId.value < peerId) {
    const dc = pc.createDataChannel('fileTransfer', {
      ordered: true,
      maxRetransmits: 10
    });
    setupDataChannel(dc, peerId);
  }

  // 接收数据通道
  pc.ondatachannel = (event) => {
    const dc = event.channel;
    setupDataChannel(dc, peerId);
  };
};

// 补充 setupDataChannel 函数
const setupDataChannel = (dc, peerId) => {
  const peer = peerConnections[peerId];
  peer.dataChannel = dc;

  dc.onopen = () => {
    peer.status = 'connected';
    console.log(`Data channel with ${peerId} opened`);
  };

  dc.onclose = () => {
    peer.status = 'disconnected';
    console.log(`Data channel with ${peerId} closed`);
  };

  dc.onerror = (error) => {
    console.error(`Data channel error with ${peerId}:`, error);
    closePeerConnection(peerId);
  };

  dc.onmessage = (event) => {
    try {
      // 处理文本消息（元数据和ACK）
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        handleDataChannelMessage(msg, peerId);
      }
      // 处理二进制数据（文件块）
      else {
        handleFileChunk(event.data, peerId);
      }
    } catch (error) {
      console.error('Error processing data channel message:', error);
    }
  };
};

// 补充 createOffer 函数
const createOffer = async (peerId) => {
  const pc = peerConnections[peerId]?.connection;
  if (!pc) return;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWsMessage('offer', { sdp: offer, to: peerId });
  } catch (error) {
    console.error('Error creating offer:', error);
    closePeerConnection(peerId);
  }
};

// 补充 closePeerConnection 函数
const closePeerConnection = (peerId) => {
  const peer = peerConnections[peerId];
  if (!peer) return;

  // 关闭连接
  if (peer.connection) {
    peer.connection.close();
  }

  // 清理状态
  delete peerConnections[peerId];

  // 清理进行中的传输
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (transfer.peers[peerId]) {
      delete transfer.peers[peerId];

      // 检查是否所有对等端都断开
      if (Object.keys(transfer.peers).length === 0 && !transfer.isComplete) {
        if (transfer.reject) {
          transfer.reject(new Error('All peers disconnected during transfer'));
        }
        delete outgoingTransfers[fileId];
      }
    }
  }

  console.log(`Closed connection to peer ${peerId}`);
};

// 补充 handleDataChannelMessage 函数
const handleDataChannelMessage = (msg, peerId) => {
  switch (msg.type) {
    case 'file-metadata':
      handleFileMetadata(msg, peerId);
      break;
    case 'chunk-ack':
      handleChunkAck(msg.fileId, msg.chunkIndex, peerId);
      break;
    case 'file-transfer-complete':
      handleTransferComplete(msg.fileId, peerId);
      break;
    default:
      console.warn('Unknown data channel message type:', msg.type);
  }
};

// 补充 handleFileMetadata 函数
const handleFileMetadata = (metadata, peerId) => {
  const fileId = metadata.fileId;

  // 避免重复接收
  if (incomingFiles[fileId]) return;

  incomingFiles[fileId] = {
    name: metadata.name,
    size: metadata.size,
    type: metadata.fileType,
    receivedChunks: new Map(),
    chunksCount: Math.ceil(metadata.size / metadata.chunkSize),
    chunksReceived: 0,
    progress: 0,
    fileId: fileId,
    peerId: peerId,
    startTime: Date.now()
  };

  // 添加到接收文件列表
  receivedFiles.push({
    id: fileId,
    name: metadata.name,
    size: metadata.size,
    progress: 0,
    url: '',
    peerId: peerId
  });

  console.log(`Receiving file ${metadata.name} (${formatBytes(metadata.size)}) from ${peerId}`);
};

// 补充 handleFileChunk 函数
const handleFileChunk = (data, peerId) => {
  try {
    const view = new DataView(data);
    let offset = 0;

    // 解析头部
    const fileIdLength = view.getUint8(offset++);
    const fileId = new TextDecoder().decode(
      data.slice(offset, offset + fileIdLength)
    );
    offset += fileIdLength;

    const chunkIndex = view.getUint32(offset, true);
    offset += 4;

    // 提取时间戳用于ACK
    const timestamp = Number(view.getBigUint64(offset, true));
    offset += 8;

    // 提取块数据
    const chunkData = data.slice(offset);

    // 处理文件块
    const fileInfo = incomingFiles[fileId];
    if (!fileInfo) {
      console.warn(`Received chunk for unknown file: ${fileId}`);
      return;
    }

    // 避免重复接收
    if (fileInfo.receivedChunks.has(chunkIndex)) {
      return;
    }

    // 存储块
    fileInfo.receivedChunks.set(chunkIndex, chunkData);
    fileInfo.chunksReceived++;

    // 更新进度
    const progress = Math.floor((fileInfo.chunksReceived / fileInfo.chunksCount) * 100);
    fileInfo.progress = progress;

    // 更新UI
    const receivedFile = receivedFiles.find(f => f.id === fileId);
    if (receivedFile) {
      receivedFile.progress = progress;
    }

    // 发送ACK
    const dc = peerConnections[peerId]?.dataChannel;
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'chunk-ack',
        fileId: fileId,
        chunkIndex: chunkIndex,
        timestamp: timestamp
      }));
    }

    // 检查是否完成
    if (fileInfo.chunksReceived === fileInfo.chunksCount) {
      finalizeFile(fileId);
    }
  } catch (error) {
    console.error('Error processing file chunk:', error);
  }
};

// 补充 finalizeFile 函数
const finalizeFile = (fileId) => {
  const fileInfo = incomingFiles[fileId];
  if (!fileInfo) return;

  try {
    // 按顺序组合块
    const chunks = [];
    for (let i = 0; i < fileInfo.chunksCount; i++) {
      const chunk = fileInfo.receivedChunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} for file ${fileInfo.name}`);
      }
      chunks.push(chunk);
    }

    // 创建Blob
    const blob = new Blob(chunks, { type: fileInfo.type });

    // 创建下载URL
    const url = URL.createObjectURL(blob);

    // 更新UI
    const receivedFile = receivedFiles.find(f => f.id === fileId);
    if (receivedFile) {
      receivedFile.progress = 100;
      receivedFile.url = url;
      receivedFile.size = blob.size;
    }

    // 清理临时数据
    delete incomingFiles[fileId];

    console.log(`File ${fileInfo.name} received successfully in ${(Date.now() - fileInfo.startTime) / 1000} seconds`);
  } catch (error) {
    console.error(`Error finalizing file ${fileInfo.name}:`, error);

    // 更新UI显示错误
    const receivedFile = receivedFiles.find(f => f.id === fileId);
    if (receivedFile) {
      receivedFile.progress = -1; // 错误状态
    }
  }
};

// 补充 handleTransferComplete 函数
const handleTransferComplete = (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer && transfer.peers[peerId]) {
    transfer.peers[peerId].isPeerComplete = true;
    checkOverallTransferCompletion(fileId);
  }
};

// 补充生命周期钩子
onMounted(() => {
  connectWebSocket();
  startRetransmissionTimer();
});

onUnmounted(() => {
  // 清理资源
  ws.value?.close();
  stopHeartbeat();
  stopUiUpdateTimer();
  stopAdaptiveControlTimer();
  stopRetransmissionTimer();

  // 关闭所有对等连接
  Object.keys(peerConnections).forEach(closePeerConnection);

  // 清理接收文件的URL
  receivedFiles.forEach(file => {
    if (file.url) URL.revokeObjectURL(file.url);
  });
});
</script>

<style scoped>
.webrtc-file-transfer-container {

  max-width: 800px;

  margin: 0 auto;

  padding: 20px;

  font-family: Arial, sans-serif;

}

.connection-info,
.file-transfer-section,
.received-files-section {

  margin-bottom: 20px;

  padding: 15px;

  border: 1px solid #eee;

  border-radius: 8px;

}

h2,
h3 {

  color: #333;

}

input[type="file"] {

  margin: 10px 0;

}

button {

  background-color: #4CAF50;

  color: white;

  padding: 10px 15px;

  border: none;

  border-radius: 4px;

  cursor: pointer;

}

button:disabled {

  background-color: #cccccc;

  cursor: not-allowed;

}

.file-info {

  margin: 10px 0;

}

.progress-container {

  height: 20px;

  background-color: #f0f0f0;

  border-radius: 10px;

  margin: 10px 0;

  position: relative;

}

.progress-bar {

  height: 100%;

  background-color: #4CAF50;

  border-radius: 10px;

  transition: width 0.3s;

}

.progress-text,
.speed-indicator {

  position: absolute;

  top: 0;

  color: #333;

  font-size: 12px;

  line-height: 20px;

}

.progress-text {

  left: 10px;

}

.speed-indicator {

  right: 10px;

}

.error-message {

  color: #ff0000;

}

.transfer-stats {

  margin-top: 10px;

  font-size: 14px;

}

.file-list {

  margin-top: 10px;

}

.file-item {

  margin-bottom: 10px;

  padding: 10px;

  border: 1px solid #ddd;

  border-radius: 4px;

}

.file-header {

  display: flex;

  justify-content: space-between;

  margin-bottom: 5px;

}

.file-progress {

  height: 10px;

  background-color: #f0f0f0;

  border-radius: 5px;

  position: relative;

}

.download-btn {

  color: white;

  background-color: #2196F3;

  padding: 3px 8px;

  border-radius: 3px;

  text-decoration: none;

}

.connected {
  color: green;
}

.connecting {
  color: orange;
}

.disconnected {
  color: red;
}
</style>
