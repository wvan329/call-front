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
        <p>分块大小: {{ formatBytes(currentChunkSize) }}</p>
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
const INITIAL_CHUNK_SIZE = 64 * 1024; // 初始分块大小 64KB
const MAX_CHUNK_SIZE = 256 * 1024;    // 最大分块大小 256KB
const MIN_CHUNK_SIZE = 32 * 1024;     // 最小分块大小 32KB
const MAX_BUFFERED_AMOUNT = 5 * 1024 * 1024; // 5MB 缓冲区
const RETRANSMIT_TIMEOUT = 2500;      // 2.5秒重传超时
const MAX_RETRANSMITS = 20;           // 最大重传次数
const HEARTBEAT_INTERVAL = 25000;     // 25秒心跳间隔
const UI_UPDATE_INTERVAL = 100;       // 100ms UI更新间隔
const HIGH_SPEED_THRESHOLD = 10 * 1024 * 1024; // 10MB/s 高速阈值
const LOW_SPEED_THRESHOLD = 1 * 1024 * 1024;   // 1MB/s 低速阈值

// --- Reactive State ---
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const errorMessage = ref('');
const isTransferring = ref(false);
const currentChunkSize = ref(INITIAL_CHUNK_SIZE); // 可动态调整的分块大小

// RTCPeerConnection 管理
const peerConnections = reactive({});

// 外发传输管理
const outgoingTransfers = reactive({});

// 接收文件管理
const incomingFiles = reactive({});

// UI相关状态
const totalBytesSent = ref(0);
const lastSpeedCalcTime = ref(0);
const lastBytesSentForSpeed = ref(0);
const currentSendSpeed = ref(0);
const sendProgress = ref(0);
const receivedFiles = reactive([]);

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

const sendMetaData = (dc, fileId, name, size, type) => {
  const metadata = {
    type: 'file-metadata',
    fileId, name, size, type,
    chunkSize: currentChunkSize.value // 发送当前分块大小
  };
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`Sent metadata for file ${fileId} (${name}) to peer.`);
  } catch (e) {
    console.error('Error sending metadata:', e);
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
  // 清理现有传输
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
    peerConnections[id].status === 'connected' && peerConnections[id].dataChannel?.readyState === 'open'
  );

  if (activePeers.length === 0) {
    errorMessage.value = '没有可用的对等连接！';
    isTransferring.value = false;
    return;
  }

  isTransferring.value = true;
  errorMessage.value = '';
  totalBytesSent.value = 0;
  lastSpeedCalcTime.value = Date.now();
  lastBytesSentForSpeed.value = 0;
  currentSendSpeed.value = 0;
  sendProgress.value = 0;
  currentChunkSize.value = INITIAL_CHUNK_SIZE; // 重置分块大小
  startUiUpdateTimer();

  const file = selectedFile.value;
  const fileId = generateUniqueId();
  const totalChunks = Math.ceil(file.size / currentChunkSize.value);

  outgoingTransfers[fileId] = {
    file, fileId, totalChunks,
    sentChunks: new Set(),
    ackedChunks: new Set(),
    pendingAcks: new Map(),
    peers: {},
    transferStartTime: Date.now(),
    isComplete: false,
    resolve: null,
    reject: null
  };

  const currentTransfer = outgoingTransfers[fileId];
  const transferPromise = new Promise((resolve, reject) => {
    currentTransfer.resolve = resolve;
    currentTransfer.reject = reject;
  });

  activePeers.forEach(peerId => {
    const peerTransfer = {
      reader: new FileReader(),
      readerBusy: false,
      readerQueue: [],
      isPeerComplete: false,
      lastAckTime: Date.now()
    };
    currentTransfer.peers[peerId] = peerTransfer;

    peerTransfer.reader.onload = (e) => {
      peerTransfer.readerBusy = false;
      const { chunkIndex } = peerTransfer.readerQueue.shift();
      const chunkDataArrayBuffer = e.target.result;

      const fullPacket = createDataPacket(currentTransfer.fileId, chunkIndex, chunkDataArrayBuffer);
      const dc = peerConnections[peerId]?.dataChannel;
      if (dc?.readyState === 'open' && dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
        try {
          dc.send(fullPacket);
          currentTransfer.sentChunks.add(chunkIndex);
          currentTransfer.pendingAcks.set(chunkIndex, {
            timestamp: Date.now(),
            retries: 0,
            data: fullPacket
          });
          totalBytesSent.value += chunkDataArrayBuffer.byteLength;
        } catch (sendError) {
          console.error(`Error sending chunk ${chunkIndex} to ${peerId}:`, sendError);
          closePeerConnection(peerId);
        }
      } else {
        console.warn(`DataChannel not ready or buffer full for ${peerId}.`);
      }
      processOutgoingQueue(currentTransfer.fileId, peerId);
    };

    peerTransfer.reader.onerror = (e) => {
      peerTransfer.readerBusy = false;
      console.error(`FileReader error for ${peerId}:`, e.target.error);
      peerTransfer.isPeerComplete = true;
      errorMessage.value = `文件读取失败: ${e.target.error.message}`;
      if (currentTransfer.reject) currentTransfer.reject(e.target.error);
      currentTransfer.isComplete = true;
    };

    const dc = peerConnections[peerId]?.dataChannel;
    if (dc?.readyState === 'open') {
      sendMetaData(dc, fileId, file.name, file.size, file.type || 'application/octet-stream');
      processOutgoingQueue(fileId, peerId);
    } else {
      console.log(`DataChannel for ${peerId} not open yet.`);
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
    stopUiUpdateTimer();
  }
};

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
    sendWsMessage('get-users');
  };

  ws.value.onmessage = async (event) => {
    if (event.data === 'pong') return;

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
          console.warn('Unknown WebSocket message type:', msg.type);
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

  onlinePeers.forEach(peerId => {
    if (!currentPeers.has(peerId)) {
      createPeerConnection(peerId);
      if (mySessionId.value < peerId) {
        createOffer(peerId);
      }
    }
  });

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

  peerConnections[peerId] = {
    pc,
    dataChannel: null,
    status: 'connecting'
  };

  const dataChannel = pc.createDataChannel('file-transfer-channel', {
    ordered: true,
    maxRetransmits: 0
  });
  peerConnections[peerId].dataChannel = dataChannel;
  setupDataChannel(dataChannel, peerId);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWsMessage('candidate', { candidate: event.candidate }, peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`PeerConnection state with ${peerId}: ${pc.connectionState}`);
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      closePeerConnection(peerId);
    } else if (pc.connectionState === 'connected') {
      peerConnections[peerId].status = 'connected';
    }
  };

  pc.ondatachannel = (event) => {
    console.log(`Incoming DataChannel from ${peerId}`);
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

  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (transfer.peers[peerId]) {
      transfer.peers[peerId].isPeerComplete = true;
      if (transfer.peers[peerId].readerBusy) {
        transfer.peers[peerId].reader.abort();
      }
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

  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    const activePeers = Object.keys(transfer.peers).filter(pId =>
      peerConnections[pId] && peerConnections[pId].status === 'connected' && !transfer.peers[pId].isPeerComplete
    );
    if (activePeers.length === 0 && !transfer.isComplete) {
      transfer.reject(new Error(`All peers disconnected for transfer ${fileId}`));
      transfer.isComplete = true;
    }
  }
};

const setupDataChannel = (dc, peerId) => {
  dc.onopen = () => {
    console.log(`DataChannel to ${peerId} opened!`);
    if (peerConnections[peerId]) {
      peerConnections[peerId].status = 'connected';
      for (const fileId in outgoingTransfers) {
        processOutgoingQueue(fileId, peerId);
      }
    }
  };

  dc.onclose = () => {
    console.log(`DataChannel to ${peerId} closed.`);
    closePeerConnection(peerId);
  };

  dc.onerror = (error) => {
    console.error(`DataChannel error with ${peerId}:`, error);
    closePeerConnection(peerId);
  };

  dc.onbufferedamountlow = () => {
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
  const pc = createPeerConnection(peerId);
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
  } catch (error) {
    if (!error.message.includes('already added') && !error.message.includes('closed')) {
      console.error(`Failed to add ICE candidate from ${peerId}:`, error);
    }
  }
};

const createDataPacket = (fileId, chunkIndex, chunkData) => {
  const fileIdBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(1 + fileIdBytes.length + 4);

  let offset = 0;
  header[offset++] = fileIdBytes.length;
  header.set(fileIdBytes, offset);
  offset += fileIdBytes.length;

  new DataView(header.buffer).setUint32(offset, chunkIndex, true);

  if (chunkData) {
    const packet = new Uint8Array(header.length + chunkData.byteLength);
    packet.set(header, 0);
    packet.set(new Uint8Array(chunkData), header.length);
    return packet.buffer;
  }
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
        const isBeingReadByAnyPeer = Object.values(transfer.peers).some(peerTransfer =>
          peerTransfer.readerBusy && peerTransfer.readerQueue[0]?.chunkIndex === chunkIndex
        );

        if (Date.now() - item.timestamp > RETRANSMIT_TIMEOUT && !isBeingReadByAnyPeer) {
          if (item.retries < MAX_RETRANSMITS) {
            for (const peerId in transfer.peers) {
              const peer = peerConnections[peerId];
              const dc = peer?.dataChannel;
              if (dc?.readyState === 'open' && !transfer.peers[peerId].isPeerComplete) {
                if (dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
                  try {
                    dc.send(item.data);
                    item.timestamp = Date.now();
                    item.retries++;
                    return;
                  } catch (e) {
                    console.error(`Error retransmitting chunk ${chunkIndex} to ${peerId}:`, e);
                  }
                }
              }
            }
          } else {
            console.error(`Max retransmits reached for chunk ${chunkIndex} of ${fileId}.`);
            transfer.pendingAcks.delete(chunkIndex);
          }
        }
      });
    }
    if (Object.keys(outgoingTransfers).length === 0 && !isTransferring.value) {
      stopRetransmissionTimer();
    }
  }, 500);
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
    currentSendSpeed.value = bytesDiff / timeDiffSeconds;
    lastBytesSentForSpeed.value = totalBytesSent.value;
    lastSpeedCalcTime.value = now;
  }

  if (selectedFile.value && selectedFile.value.size > 0 && Object.keys(outgoingTransfers).length > 0) {
    const currentFileTransfer = Object.values(outgoingTransfers).find(t => t.file.name === selectedFile.value.name);
    if (currentFileTransfer && currentFileTransfer.totalChunks > 0) {
      sendProgress.value = (currentFileTransfer.ackedChunks.size / currentFileTransfer.totalChunks) * 100;
    } else {
      sendProgress.value = 0;
    }
  } else {
    sendProgress.value = 0;
  }

  // --- 关键新增：动态调整分块大小 ---
  adjustChunkSizeBasedOnSpeed();
};

// --- 新增：动态调整分块大小 ---
const adjustChunkSizeBasedOnSpeed = () => {
  if (isTransferring.value && selectedFile.value) {
    // 如果速度超过高速阈值，尝试减小分块大小
    if (currentSendSpeed.value > HIGH_SPEED_THRESHOLD && currentChunkSize.value > MIN_CHUNK_SIZE) {
      currentChunkSize.value = Math.max(
        MIN_CHUNK_SIZE,
        Math.floor(currentChunkSize.value / 2)
      );
      console.log(`Speed too high (${formatSpeed(currentSendSpeed.value)}), reducing chunk size to ${formatBytes(currentChunkSize.value)}`);
    }
    // 如果速度低于低速阈值，尝试增大分块大小
    else if (currentSendSpeed.value < LOW_SPEED_THRESHOLD && currentChunkSize.value < MAX_CHUNK_SIZE) {
      currentChunkSize.value = Math.min(
        MAX_CHUNK_SIZE,
        currentChunkSize.value * 2
      );
      console.log(`Speed too low (${formatSpeed(currentSendSpeed.value)}), increasing chunk size to ${formatBytes(currentChunkSize.value)}`);
    }
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
  const { fileId, name, size, type, chunkSize } = metadata;
  if (incomingFiles[fileId]) {
    console.warn(`Metadata for ${fileId} already received.`);
    return;
  }

  const newIncomingFile = reactive({
    id: fileId,
    name,
    size,
    type,
    chunkSize,
    totalChunks: Math.ceil(size / chunkSize),
    receivedChunks: new Map(),
    receivedSize: 0,
    progress: 0,
    url: null
  });
  incomingFiles[fileId] = newIncomingFile;

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
    } catch (e) {
      console.error(`Error sending ACK for chunk ${chunkIndex} to ${peerId}:`, e);
    }
  }
};

const handleChunkAck = (fileId, chunkIndex, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer && !transfer.ackedChunks.has(chunkIndex)) {
    transfer.ackedChunks.add(chunkIndex);
    transfer.pendingAcks.delete(chunkIndex);
    processOutgoingQueue(fileId, peerId);
  }
};

const processOutgoingQueue = (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const peerTransfer = transfer.peers[peerId];
  if (!peerTransfer || peerTransfer.isPeerComplete) return;

  const dc = peerConnections[peerId]?.dataChannel;
  if (!dc || dc.readyState !== 'open') return;

  if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) return;

  if (!peerTransfer.readerBusy && peerTransfer.readerQueue.length === 0) {
    let nextChunkIndex = -1;
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.ackedChunks.has(i) && !transfer.pendingAcks.has(i)) {
        nextChunkIndex = i;
        break;
      }
    }

    if (nextChunkIndex !== -1) {
      const start = nextChunkIndex * currentChunkSize.value;
      const end = Math.min(start + currentChunkSize.value, transfer.file.size);
      const slice = transfer.file.slice(start, end);
      peerTransfer.readerQueue.push({ chunkIndex: nextChunkIndex });
      peerTransfer.readerBusy = true;
      peerTransfer.reader.readAsArrayBuffer(slice);
      return;
    }
  }

  if (transfer.ackedChunks.size === transfer.totalChunks && !peerTransfer.isPeerComplete) {
    sendCompletionMessage(dc, fileId);
    peerTransfer.isPeerComplete = true;
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

  const chunkIndex = view.getUint32(offset, true);
  offset += 4;

  const chunkPayload = chunkData.slice(offset);

  const file = incomingFiles[fileId];
  if (!file) {
    console.warn(`Received chunk for unknown fileId: ${fileId}`);
    return;
  }

  if (file.receivedChunks.has(chunkIndex)) {
    sendChunkAck(fileId, chunkIndex, peerId);
    return;
  }

  file.receivedChunks.set(chunkIndex, chunkPayload);
  file.receivedSize += chunkPayload.byteLength;
  file.progress = (file.receivedSize / file.size) * 100;

  sendChunkAck(fileId, chunkIndex, peerId);

  if (file.receivedChunks.size === file.totalChunks && file.receivedSize >= file.size) {
    finalizeIncomingFile(fileId, peerId);
  }
};

const finalizeIncomingFile = (fileId, peerId) => {
  const file = incomingFiles[fileId];
  if (!file || file.url) return;

  const expectedTotalBytes = file.size;
  const actualReceivedBytes = Array.from(file.receivedChunks.values()).reduce((sum, chunk) => sum + chunk.byteLength, 0);

  if (file.receivedChunks.size !== file.totalChunks || actualReceivedBytes < expectedTotalBytes) {
    console.warn(`Finalizing file with incomplete data: chunks ${file.receivedChunks.size}/${file.totalChunks}, bytes ${actualReceivedBytes}/${expectedTotalBytes}`);
    return;
  }

  const sortedChunks = [];
  for (let i = 0; i < file.totalChunks; i++) {
    const chunk = file.receivedChunks.get(i);
    if (!chunk) {
      console.error(`Missing chunk ${i} for file ${file.name}`);
      return;
    }
    sortedChunks.push(chunk);
  }

  const blob = new Blob(sortedChunks, { type: file.type });
  file.url = URL.createObjectURL(blob);
  file.progress = 100;
  console.log(`File ${file.name} received and finalized.`);
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