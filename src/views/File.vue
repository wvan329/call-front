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
      <p>传输速度: <span class="transfer-speed">{{ formatSpeed(currentSpeed) }}</span></p>
    </div>

    <div class="file-transfer-section">
      <h3>文件传输</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFileBroadcast" :disabled="!selectedFile || !activePeersCount">
        极速广播文件
      </button>
      <div v-if="selectedFile" class="file-info">
        <p>已选文件: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
        <p>分块大小: {{ formatBytes(CHUNK_SIZE) }} × {{ PARALLEL_STREAMS }} 并行流</p>
      </div>
      <div class="progress-container">
        <div class="progress-bar" :style="{ width: sendProgress + '%' }"></div>
        <span class="progress-text">{{ sendProgress.toFixed(1) }}%</span>
        <span class="speed-indicator">{{ formatSpeed(currentSpeed) }}/s</span>
      </div>
      <p v-if="transferError" class="error-message">{{ transferError }}</p>
    </div>

    <div class="received-files-section">
      <h3>接收文件</h3>
      <div v-if="receivedFiles.length" class="file-list">
        <div v-for="(file, index) in receivedFiles" :key="index" class="file-item">
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



// =============== 修改后的文件传输核心逻辑 ===============

// 为每个传输任务创建独立的 FileReader
const createFileReader = () => {
  const reader = new FileReader();
  let isReading = false;
  
  return {
    readAsArrayBuffer(blob) {
      return new Promise((resolve, reject) => {
        if (isReading) {
          reject(new Error('FileReader is busy'));
          return;
        }
        
        isReading = true;
        reader.onload = (e) => {
          isReading = false;
          resolve(e.target.result);
        };
        reader.onerror = (e) => {
          isReading = false;
          reject(e.target.error);
        };
        reader.readAsArrayBuffer(blob);
      });
    }
  };
};

// 增强的数据通道发送逻辑
const sendWithRetry = async (dc, data, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (dc.readyState !== 'open') {
        throw new Error('DataChannel is not open');
      }
      
      dc.send(data);
      return true;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      
      // 等待指数退避时间后重试
      await new Promise(resolve => 
        setTimeout(resolve, 100 * Math.pow(2, attempt))
      );
    }
  }
};

// 重构的 sendNextChunk 函数
const sendNextChunk = async (peerId, streamIndex) => {
  const stream = peerConnections[peerId]?.streams[streamIndex];
  if (!stream || !stream.currentTransfer) return;

  const { dc, currentTransfer } = stream;
  const { file, fileId, currentOffset, endOffset } = currentTransfer;

  // 检查是否完成
  if (currentOffset >= endOffset) {
    try {
      await sendTransferComplete(dc, fileId);
      currentTransfer.resolve();
    } catch (e) {
      currentTransfer.reject(e);
    } finally {
      stream.currentTransfer = null;
      processStreamQueue(peerId, streamIndex);
    }
    return;
  }

  try {
    // 读取下一个块
    const nextChunkSize = Math.min(CHUNK_SIZE, endOffset - currentOffset);
    const slice = file.slice(currentOffset, currentOffset + nextChunkSize);
    const chunk = await currentTransfer.reader.readAsArrayBuffer(slice);
    
    // 准备数据包
    const chunkIndex = Math.floor(currentOffset / CHUNK_SIZE);
    const isLastChunk = (currentOffset + chunk.byteLength) >= endOffset;
    const packet = createDataPacket(fileId, chunkIndex, isLastChunk, chunk);
    
    // 发送数据
    await sendWithRetry(dc, packet);
    
    // 更新状态
    currentTransfer.currentOffset += chunk.byteLength;
    updateTransferStats(chunk.byteLength);
    
    // 更新进度
    const totalSent = currentTransfer.currentOffset - currentTransfer.startOffset;
    const totalToSend = currentTransfer.endOffset - currentTransfer.startOffset;
    transferStats.progress = Math.min(
      ...peerConnections[peerId].streams
        .filter(s => s.currentTransfer?.fileId === fileId)
        .map(s => {
          const sent = s.currentTransfer.currentOffset - s.currentTransfer.startOffset;
          const total = s.currentTransfer.endOffset - s.currentTransfer.startOffset;
          return (sent / total) * 100;
        })
    );
    
    // 如果还有空间且数据未发送完，继续发送
    if (currentTransfer.currentOffset < endOffset && dc.bufferedAmount < MAX_BUFFER_SIZE * 0.8) {
      sendNextChunk(peerId, streamIndex);
    }
  } catch (e) {
    console.error('发送块失败:', e);
    currentTransfer.reject(e);
    stream.currentTransfer = null;
    
    // 如果是连接问题，关闭整个PeerConnection
    if (e.message.includes('not open') || e.message.includes('Failure to send')) {
      closePeerConnection(peerId);
    }
  }
};

// 增强的传输任务创建
const createTransferTask = (file, peerId, streamIndex, startOffset, endOffset) => {
  const fileId = generateFileId();
  
  return {
    file,
    fileId,
    startOffset,
    endOffset,
    currentOffset: startOffset,
    reader: createFileReader(), // 使用独立的FileReader
    streamIndex,
    resolve: null,
    reject: null,
    promise: new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    })
  };
};

// 修改后的 sendFileToPeer
const sendFileToPeer = (peerId, file) => {
  if (!peerConnections[peerId]) {
    throw new Error(`没有与 ${peerId} 的连接`);
  }
  
  const fileSize = file.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunksPerStream = Math.ceil(totalChunks / PARALLEL_STREAMS);
  
  // 为每个流创建传输任务
  const transferPromises = peerConnections[peerId].streams.map((stream, index) => {
    const startChunk = index * chunksPerStream;
    const endChunk = Math.min((index + 1) * chunksPerStream, totalChunks);
    
    if (startChunk >= endChunk) {
      return Promise.resolve(); // 这个流不需要传输数据
    }
    
    const startOffset = startChunk * CHUNK_SIZE;
    const endOffset = Math.min(endChunk * CHUNK_SIZE, fileSize);
    
    const transfer = createTransferTask(file, peerId, index, startOffset, endOffset);
    stream.queue.push(transfer);
    processStreamQueue(peerId, index);
    
    return transfer.promise;
  });
  
  return Promise.all(transferPromises);
};

// 增强的 closePeerConnection
const closePeerConnection = (peerId) => {
  if (!peerConnections[peerId]) return;
  
  // 拒绝所有未完成的传输
  peerConnections[peerId].streams.forEach(stream => {
    stream.queue.forEach(transfer => transfer.reject(new Error('Connection closed')));
    if (stream.currentTransfer) {
      stream.currentTransfer.reject(new Error('Connection closed'));
    }
    stream.queue = [];
    stream.currentTransfer = null;
    
    // 关闭数据通道
    if (stream.dc) {
      try {
        stream.dc.close();
      } catch (e) {
        console.error('关闭数据通道错误:', e);
      }
    }
  });
  
  // 关闭PeerConnection
  if (peerConnections[peerId].pc) {
    try {
      peerConnections[peerId].pc.close();
    } catch (e) {
      console.error('关闭PeerConnection错误:', e);
    }
  }
  
  delete peerConnections[peerId];
  console.log(`已关闭与 ${peerId} 的连接`);
};























// =============== 新增的 WebSocket 消息处理函数 ===============
const handleUserList = (users) => {
  const onlinePeers = users.filter(id => id !== mySessionId.value);
  const currentPeers = Object.keys(peerConnections);

  // 添加新连接
  onlinePeers.forEach(peerId => {
    if (!currentPeers.includes(peerId)) {
      // 按字母顺序决定谁发起offer，避免冲突
      if (mySessionId.value < peerId) {
        createOffer(peerId);
      } else {
        // 先创建PeerConnection但不发起offer
        createPeerConnection(peerId);
      }
    }
  });

  // 移除离线连接
  currentPeers.forEach(peerId => {
    if (!onlinePeers.includes(peerId)) {
      closePeerConnection(peerId);
    }
  });
};

const handleSignalingMessage = async (msg) => {
  const { type, from } = msg;

  try {
    switch (type) {
      case 'offer':
        await handleOffer(msg.sdp, from);
        break;
      case 'answer':
        await handleAnswer(msg.sdp, from);
        break;
      case 'candidate':
        await handleCandidate(msg.candidate, from);
        break;
      case 'user-left':
        closePeerConnection(from);
        break;
      default:
        console.warn('未知的信令消息类型:', type);
    }
  } catch (e) {
    console.error('处理信令消息错误:', e);
  }
};

// =============== WebRTC 信令处理 ===============
const createOffer = async (peerId) => {
  const pc = createPeerConnection(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWsMessage('offer', { sdp: offer }, peerId);
    console.log(`已发送offer给 ${peerId}`);
  } catch (e) {
    console.error('创建offer失败:', e);
    closePeerConnection(peerId);
  }
};

const handleOffer = async (sdp, peerId) => {
  const pc = createPeerConnection(peerId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWsMessage('answer', { sdp: answer }, peerId);
    console.log(`已发送answer给 ${peerId}`);
  } catch (e) {
    console.error('处理offer失败:', e);
    closePeerConnection(peerId);
  }
};

const handleAnswer = async (sdp, peerId) => {
  const pc = peerConnections[peerId]?.pc;
  if (!pc) {
    console.warn(`收到answer但没有对应的PeerConnection: ${peerId}`);
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) {
    console.error('处理answer失败:', e);
    closePeerConnection(peerId);
  }
};

const handleCandidate = async (candidate, peerId) => {
  const pc = peerConnections[peerId]?.pc;
  if (!pc) {
    console.warn(`收到ICE candidate但没有对应的PeerConnection: ${peerId}`);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('添加ICE candidate失败:', e);
  }
};

// =============== 修改后的 connectWebSocket 函数 ===============
const connectWebSocket = () => {
  if (ws.value?.readyState === WebSocket.OPEN) return;

  ws.value = new WebSocket(WS_URL);

  ws.value.onopen = () => {
    console.log('WebSocket 连接已建立');
    startHeartbeat();
    // 请求用户列表
    sendWsMessage('get-users');
  };

  ws.value.onmessage = async (event) => {
    if (event.data === 'pong') return;

    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'session-id') {
        mySessionId.value = msg.id;
        return;
      }

      if (msg.type === 'user-list') {
        handleUserList(msg.users);
        return;
      }

      if (msg.from) {
        handleSignalingMessage(msg);
      }
    } catch (e) {
      console.error('处理消息错误:', e);
    }
  };

  ws.value.onclose = () => {
    console.log('WebSocket 连接关闭');
    stopHeartbeat();
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    console.error('WebSocket 错误:', error);
    ws.value.close();
  };
};












































import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';

// =============== 配置常量 ===============
const WS_URL = 'ws://59.110.35.198/wgk/ws/file';
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }];
const CHUNK_SIZE = 256 * 1024; // 256KB 分块
const PARALLEL_STREAMS = 4;    // 并行数据流数
const MAX_BUFFER_SIZE = 32 * 1024 * 1024; // 32MB 最大缓冲区
const HEARTBEAT_INTERVAL = 25000; // 25秒心跳

// =============== 状态变量 ===============
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const transferError = ref('');
const receivedFiles = reactive([]);
const peerConnections = reactive({});
const incomingFiles = reactive({});

// 传输统计
const transferStats = reactive({
  bytesSent: 0,
  lastBytesSent: 0,
  lastTime: 0,
  speed: 0,
  progress: 0
});

// =============== 计算属性 ===============
const wsStatus = computed(() => {
  if (!ws.value) return { class: 'disconnected', text: '未连接' };
  switch (ws.value.readyState) {
    case WebSocket.OPEN: return { class: 'connected', text: '已连接' };
    case WebSocket.CONNECTING: return { class: 'connecting', text: '连接中' };
    default: return { class: 'disconnected', text: '已断开' };
  }
});

const activePeersCount = computed(() => {
  return Object.values(peerConnections).filter(pc =>
    pc.streams.some(s => s.dc?.readyState === 'open')
  ).length;
});

const currentSpeed = computed(() => transferStats.speed);
const sendProgress = computed(() => transferStats.progress);

// =============== 工具函数 ===============
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
};

const formatSpeed = (bytes) => {
  return formatBytes(bytes) + '/s';
};

const generateFileId = () => {
  return `${mySessionId.value}-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
};

const sendWsMessage = (type, data = {}, to = null) => {
  if (ws.value?.readyState !== WebSocket.OPEN) return;

  const message = { type, ...data };
  if (to) message.to = to;

  ws.value.send(JSON.stringify(message));
};

const startHeartbeat = () => {
  const heartbeat = setInterval(() => {
    if (ws.value?.readyState === WebSocket.OPEN) {
      sendWsMessage('ping');
    } else {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL);
};

const stopHeartbeat = () => {
  // 实际清除在 startHeartbeat 中处理
};

// =============== WebRTC 核心逻辑 ===============
const createPeerConnection = (peerId) => {
  if (peerConnections[peerId]) return peerConnections[peerId].pc;

  console.log(`创建 PeerConnection 给 ${peerId}`);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // 初始化并行流
  const streams = Array(PARALLEL_STREAMS).fill().map((_, i) => ({
    dc: null,
    queue: [],
    currentTransfer: null,
    stats: { bytesSent: 0 }
  }));

  peerConnections[peerId] = { pc, streams };

  // ICE 候选处理
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWsMessage('candidate', { candidate: event.candidate }, peerId);
    }
  };

  // 连接状态处理
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      closePeerConnection(peerId);
    }
  };

  // 数据通道处理
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    const streamIndex = parseInt(channel.label.split('-')[2]) || 0;

    if (peerConnections[peerId]?.streams[streamIndex]) {
      peerConnections[peerId].streams[streamIndex].dc = channel;
      setupDataChannel(channel, peerId, streamIndex);
    }
  };

  // 创建出站数据通道
  streams.forEach((_, index) => {
    const dc = pc.createDataChannel(`file-stream-${index}`, {
      ordered: true,
      maxRetransmits: 30
    });
    streams[index].dc = dc;
    setupDataChannel(dc, peerId, index);
  });

  return pc;
};

const setupDataChannel = (dc, peerId, streamIndex) => {
  dc.onopen = () => {
    console.log(`数据通道 ${streamIndex} 已打开 (${peerId})`);
    processStreamQueue(peerId, streamIndex);
  };

  dc.onclose = () => {
    console.log(`数据通道 ${streamIndex} 已关闭 (${peerId})`);
    peerConnections[peerId].streams[streamIndex].dc = null;
  };

  dc.onerror = (error) => {
    console.error(`数据通道 ${streamIndex} 错误 (${peerId}):`, error);
  };

  dc.onbufferedamountlow = () => {
    processStreamQueue(peerId, streamIndex);
  };

  dc.onmessage = (event) => {
    handleReceivedData(event.data, peerId);
  };
};


// =============== 文件传输逻辑 ===============
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  transferError.value = '';
  transferStats.progress = 0;
};

const sendFileBroadcast = async () => {
  if (!selectedFile.value) {
    transferError.value = '请先选择文件';
    return;
  }

  const activePeers = Object.keys(peerConnections).filter(peerId =>
    peerConnections[peerId].streams.some(s => s.dc?.readyState === 'open')
  );

  if (!activePeers.length) {
    transferError.value = '没有可用的对等连接';
    return;
  }

  transferError.value = '';
  transferStats.bytesSent = 0;
  transferStats.lastBytesSent = 0;
  transferStats.lastTime = Date.now();
  transferStats.speed = 0;
  transferStats.progress = 0;

  try {
    await Promise.all(activePeers.map(peerId =>
      sendFileToPeer(peerId, selectedFile.value)
    ));

    transferStats.progress = 100;
    console.log('文件广播完成');
  } catch (error) {
    transferError.value = `广播失败: ${error.message}`;
    console.error('广播错误:', error);
  }
};

const processStreamQueue = (peerId, streamIndex) => {
  const stream = peerConnections[peerId]?.streams[streamIndex];
  if (!stream || !stream.dc || stream.dc.readyState !== 'open') return;

  // 如果没有正在进行的传输，从队列中取一个
  if (!stream.currentTransfer && stream.queue.length > 0) {
    stream.currentTransfer = stream.queue.shift();
    sendFileMetadata(stream.dc, stream.currentTransfer);
  }

  // 如果有正在进行的传输且缓冲区有空间，继续发送
  if (stream.currentTransfer && stream.dc.bufferedAmount < MAX_BUFFER_SIZE) {
    sendNextChunk(peerId, streamIndex);
  }
};

const sendFileMetadata = (dc, transfer) => {
  const metadata = {
    type: 'file-metadata',
    fileId: transfer.fileId,
    name: transfer.file.name,
    size: transfer.file.size,
    type: transfer.file.type || 'application/octet-stream',
    streamIndex: transfer.streamIndex
  };

  try {
    dc.send(JSON.stringify(metadata));
    console.log(`发送文件元数据: ${transfer.fileId}`);
  } catch (e) {
    console.error('发送元数据失败:', e);
    transfer.reject(e);
  }
};


const updateTransferStats = (bytesSent) => {
  const now = Date.now();
  transferStats.bytesSent += bytesSent;

  // 计算速度 (每500ms更新一次)
  if (now - transferStats.lastTime > 500) {
    const timeDiff = (now - transferStats.lastTime) / 1000;
    const bytesDiff = transferStats.bytesSent - transferStats.lastBytesSent;
    transferStats.speed = bytesDiff / timeDiff;
    transferStats.lastBytesSent = transferStats.bytesSent;
    transferStats.lastTime = now;
  }
};

const createDataPacket = (fileId, chunkIndex, isLastChunk, chunkData) => {
  const fileIdBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(1 + fileIdBytes.length + 4 + 1);

  let offset = 0;
  header[offset++] = fileIdBytes.length;
  header.set(fileIdBytes, offset);
  offset += fileIdBytes.length;

  new DataView(header.buffer).setUint32(offset, chunkIndex, true);
  offset += 4;

  header[offset++] = isLastChunk ? 1 : 0;

  const packet = new Uint8Array(header.length + chunkData.byteLength);
  packet.set(header, 0);
  packet.set(new Uint8Array(chunkData), header.length);

  return packet.buffer;
};

const sendTransferComplete = (dc, fileId) => {
  const completeMsg = {
    type: 'file-complete',
    fileId: fileId
  };

  try {
    dc.send(JSON.stringify(completeMsg));
  } catch (e) {
    console.error('发送完成消息失败:', e);
  }
};

// =============== 文件接收逻辑 ===============
const handleReceivedData = (data, peerId) => {
  try {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'file-metadata') {
        createIncomingFile(msg);
      } else if (msg.type === 'file-complete') {
        finalizeIncomingFile(msg.fileId);
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      processReceivedChunk(data);
    }
  } catch (e) {
    console.error('处理接收数据错误:', e);
  }
};

const createIncomingFile = (metadata) => {
  if (incomingFiles[metadata.fileId]) return;

  const file = {
    id: metadata.fileId,
    name: metadata.name,
    size: metadata.size,
    type: metadata.type,
    receivedSize: 0,
    chunks: {},
    progress: 0,
    url: null
  };

  incomingFiles[metadata.fileId] = file;

  // 添加到接收文件列表
  receivedFiles.push(reactive({
    name: file.name,
    size: file.size,
    progress: 0,
    url: null
  }));
};

const processReceivedChunk = (chunkData) => {
  const view = new DataView(chunkData);
  let offset = 0;

  const fileIdLen = view.getUint8(offset++);
  const fileId = new TextDecoder().decode(chunkData.slice(offset, offset + fileIdLen));
  offset += fileIdLen;

  const chunkIndex = view.getUint32(offset, true);
  offset += 4;

  const isLastChunk = view.getUint8(offset++);
  const chunk = chunkData.slice(offset);

  if (!incomingFiles[fileId]) return;

  const file = incomingFiles[fileId];
  const receivedFile = receivedFiles.find(f => f.name === file.name);

  // 如果已经接收过这个块，跳过
  if (file.chunks[chunkIndex]) return;

  file.chunks[chunkIndex] = chunk;
  file.receivedSize += chunk.byteLength;
  file.progress = (file.receivedSize / file.size) * 100;

  // 更新UI进度
  if (receivedFile) {
    receivedFile.progress = file.progress;
  }

  // 如果是最后一个块或者已经接收完所有数据
  if (isLastChunk || file.receivedSize >= file.size) {
    finalizeIncomingFile(fileId);
  }
};

const finalizeIncomingFile = (fileId) => {
  if (!incomingFiles[fileId]) return;

  const file = incomingFiles[fileId];
  const receivedFile = receivedFiles.find(f => f.name === file.name);

  // 确保所有块都已接收
  const expectedChunks = Math.ceil(file.size / CHUNK_SIZE);
  const receivedChunks = Object.keys(file.chunks).length;

  if (receivedChunks < expectedChunks || file.receivedSize < file.size) {
    console.warn(`文件 ${file.name} 接收不完整 (${receivedChunks}/${expectedChunks} 块)`);
    return;
  }

  // 按顺序重组文件
  const chunks = Array(expectedChunks)
    .fill()
    .map((_, i) => file.chunks[i]);

  const blob = new Blob(chunks, { type: file.type });
  const url = URL.createObjectURL(blob);

  // 更新接收文件
  if (receivedFile) {
    receivedFile.url = url;
    receivedFile.progress = 100;
  }

  // 清理
  delete incomingFiles[fileId];
};

// =============== 生命周期 ===============
onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  if (ws.value) ws.value.close();
  Object.keys(peerConnections).forEach(closePeerConnection);
});
</script>

<style scoped>
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