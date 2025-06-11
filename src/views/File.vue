<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC文件快传</h2>

    <div class="connection-info">
      <h3>连接状态</h3>
      <p>我的会话ID: <span class="my-id">{{ mySessionId || '未连接' }}</span></p>
      <p>WebSocket 状态:
        <span :class="isWsConnected ? 'status-connected' : 'status-disconnected'">
          {{ isWsConnected ? '已连接' : '已断开' }}
        </span>
      </p>
      <p>活跃对等端数量: <span class="connected-peers-count">{{ Object.keys(peerConnections).length }}</span></p>
    </div>

    <div class="file-transfer-section">
      <h3>选择文件</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFileBroadcast" :disabled="!selectedFile || !isAnyDataChannelOpen">
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
            <a v-if="file.url && file.progress === 100" :href="file.url" :download="file.metadata.fileName" class="download-link">Download</a>
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
const heartbeatIntervalId = ref(null);
const peerConnections = reactive({});
const selectedFile = ref(null);
const sendFileProgress = ref(0);
const fileTransferError = ref('');
const receivedFiles = reactive([]);
const incomingFileBuffers = {};

// 动态缓冲区配置
const DYNAMIC_BUFFER_CONFIG = reactive({
  baseSize: 1 * 1024 * 1024,    // 1MB基础大小
  maxSize: 16 * 1024 * 1024,    // 16MB最大限制
  currentSize: 1 * 1024 * 1024  // 当前缓冲区大小
});

// 传输统计
const transferStats = reactive({
  speed: 0,
  lastBytesSent: 0,
  lastTime: 0
});

const isAnyDataChannelOpen = computed(() => {
  return Object.values(peerConnections).some(pcInfo => pcInfo.dc && pcInfo.dc.readyState === 'open');
});

// WebRTC配置
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:59.110.35.198:3478' }
  ]
};

// 文件传输常量
const CHUNK_SIZE = 64 * 1024; // 64KB per chunk
const PARALLEL_STREAMS = 3;   // 并行数据流数量

// 工具函数保持不变
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

// 动态调整缓冲区大小
const adjustBufferSize = (dc) => {
  if (!dc) return;
  
  // 计算当前传输速度
  const now = Date.now();
  if (transferStats.lastTime > 0) {
    const timeDiff = (now - transferStats.lastTime) / 1000;
    const bytesDiff = dc.bytesSent - transferStats.lastBytesSent;
    transferStats.speed = bytesDiff / timeDiff;
  }
  transferStats.lastBytesSent = dc.bytesSent;
  transferStats.lastTime = now;
  
  // 根据网络状况调整缓冲区
  if (transferStats.speed > 5 * 1024 * 1024) { // >5MB/s
    DYNAMIC_BUFFER_CONFIG.currentSize = Math.min(
      DYNAMIC_BUFFER_CONFIG.currentSize + (1 * 1024 * 1024),
      DYNAMIC_BUFFER_CONFIG.maxSize
    );
  } else if (transferStats.speed < 1 * 1024 * 1024) { // <1MB/s
    DYNAMIC_BUFFER_CONFIG.currentSize = Math.max(
      DYNAMIC_BUFFER_CONFIG.currentSize - (0.5 * 1024 * 1024),
      DYNAMIC_BUFFER_CONFIG.baseSize
    );
  }
};

// 创建增强型PeerConnection
const createEnhancedPeerConnection = (targetPeerId) => {
  if (peerConnections[targetPeerId]?.pc) {
    return peerConnections[targetPeerId].pc;
  }

  console.log(`[${mySessionId.value}] 创建增强型PeerConnection给 ${targetPeerId}`);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  
  // 初始化并行数据流
  const streams = Array(PARALLEL_STREAMS).fill().map((_, i) => ({
    dc: null,
    fileQueue: [],
    currentTransfer: null
  }));
  
  peerConnections[targetPeerId] = { 
    pc,
    streams,
    stats: {
      bytesSent: 0,
      speed: 0
    }
  };

  // ICE Candidate处理
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage('candidate', { candidate: event.candidate }, targetPeerId);
    }
  };

  // 连接状态处理
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      closePeerConnection(targetPeerId);
    }
  };

  // 数据通道处理
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    const streamIndex = parseInt(channel.label.split('-').pop()) || 0;
    
    if (peerConnections[targetPeerId]?.streams[streamIndex]) {
      peerConnections[targetPeerId].streams[streamIndex].dc = channel;
      setupDataChannelListeners(channel, targetPeerId, streamIndex);
    }
  };

  // 为每个并行流创建数据通道
  streams.forEach((_, index) => {
    const dc = pc.createDataChannel(`file-stream-${index}`, {
      ordered: true,
      maxRetransmits: 30 // 适当增加重传次数
    });
    streams[index].dc = dc;
    setupDataChannelListeners(dc, targetPeerId, index);
  });

  return pc;
};

// 增强的数据通道监听器
const setupDataChannelListeners = (channel, peerId, streamIndex) => {
  channel.onopen = () => {
    console.log(`[${mySessionId.value}] 数据通道 ${streamIndex} 已连接 ${peerId}`);
    startStreamTransfer(peerId, streamIndex);
  };

  channel.onclose = () => {
    console.log(`[${mySessionId.value}] 数据通道 ${streamIndex} 已断开 ${peerId}`);
    if (peerConnections[peerId]?.streams[streamIndex]) {
      peerConnections[peerId].streams[streamIndex].dc = null;
    }
  };

  channel.onerror = (error) => {
    console.error(`[${mySessionId.value}] 数据通道 ${streamIndex} 错误 ${peerId}:`, error);
  };

  channel.onbufferedamountlow = () => {
    startStreamTransfer(peerId, streamIndex);
  };

  // 接收文件处理保持不变
  channel.onmessage = async (event) => {
    // 保持原有接收文件逻辑
  };
};

// 启动流传输
const startStreamTransfer = (peerId, streamIndex) => {
  const stream = peerConnections[peerId]?.streams[streamIndex];
  if (!stream || !stream.dc || stream.dc.readyState !== 'open') return;
  
  // 如果没有正在传输的文件，从队列中取一个
  if (!stream.currentTransfer && stream.fileQueue.length > 0) {
    stream.currentTransfer = stream.fileQueue.shift();
    sendFileMetadata(stream.dc, stream.currentTransfer);
  }
  
  // 如果有正在传输的文件，继续传输
  if (stream.currentTransfer && stream.dc.bufferedAmount < DYNAMIC_BUFFER_CONFIG.currentSize) {
    sendNextChunk(peerId, streamIndex);
  }
};

// 发送文件元数据
const sendFileMetadata = (dc, transfer) => {
  const metadata = {
    type: 'file-metadata-signal',
    fileId: transfer.fileId,
    fileName: transfer.file.name,
    fileType: transfer.file.type || 'application/octet-stream',
    fileSize: transfer.file.size,
    from: mySessionId.value,
    streamIndex: transfer.streamIndex
  };
  
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`[${mySessionId.value}] 发送元数据 ${transfer.fileId}`);
  } catch (e) {
    console.error(`[${mySessionId.value}] 发送元数据失败:`, e);
  }
};

// 发送下一个数据块
const sendNextChunk = async (peerId, streamIndex) => {
  const stream = peerConnections[peerId]?.streams[streamIndex];
  if (!stream || !stream.currentTransfer) return;
  
  const { file, fileId, offset, reader } = stream.currentTransfer;
  
  if (offset >= file.size) {
    // 文件传输完成
    sendTransferComplete(stream.dc, fileId);
    stream.currentTransfer.resolve();
    stream.currentTransfer = null;
    startStreamTransfer(peerId, streamIndex); // 检查队列中下一个文件
    return;
  }
  
  const slice = file.slice(offset, offset + CHUNK_SIZE);
  reader.readAsArrayBuffer(slice);
  
  reader.onload = async (e) => {
    const chunk = e.target.result;
    const chunkIndex = Math.floor(offset / CHUNK_SIZE);
    const isLastChunk = (offset + chunk.byteLength) >= file.size;
    
    try {
      const chunkPacket = createChunkPacket(fileId, chunkIndex, isLastChunk, chunk);
      
      // 动态调整缓冲区
      adjustBufferSize(stream.dc);
      
      // 检查缓冲区状态
      if (stream.dc.bufferedAmount < DYNAMIC_BUFFER_CONFIG.currentSize) {
        stream.dc.send(chunkPacket);
        stream.currentTransfer.offset += chunk.byteLength;
        
        // 更新进度
        const newProgress = (stream.currentTransfer.offset / file.size) * 100;
        sendFileProgress.value = Math.max(sendFileProgress.value, newProgress);
        
        // 如果还有空间，继续发送下一个块
        if (stream.dc.bufferedAmount < DYNAMIC_BUFFER_CONFIG.currentSize * 0.8) {
          sendNextChunk(peerId, streamIndex);
        }
      }
    } catch (e) {
      console.error(`[${mySessionId.value}] 发送块失败:`, e);
      await new Promise(resolve => setTimeout(resolve, 100));
      sendNextChunk(peerId, streamIndex); // 重试
    }
  };
  
  reader.onerror = (error) => {
    console.error(`[${mySessionId.value}] 文件读取错误:`, error);
    stream.currentTransfer.reject(error);
    stream.currentTransfer = null;
  };
};

// 创建数据块包
const createChunkPacket = (fileId, chunkIndex, isLastChunk, chunkData) => {
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

// 发送传输完成信号
const sendTransferComplete = (dc, fileId) => {
  const completeSignal = {
    type: 'file-transfer-complete-signal',
    fileId: fileId,
    from: mySessionId.value
  };
  
  try {
    dc.send(JSON.stringify(completeSignal));
  } catch (e) {
    console.error(`[${mySessionId.value}] 发送完成信号失败:`, e);
  }
};

// 发送文件到对等端 (修改后的版本)
const sendFileToPeer = (targetPeerId, file) => {
  if (!peerConnections[targetPeerId]) {
    console.warn(`[${mySessionId.value}] 无连接 ${targetPeerId}`);
    return Promise.reject(new Error(`No connection to ${targetPeerId}`));
  }
  
  const fileId = `${mySessionId.value}-${Date.now()}-${file.name}`;
  const fileSize = file.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunksPerStream = Math.ceil(totalChunks / PARALLEL_STREAMS);
  
  // 为每个流创建传输任务
  const transferPromises = peerConnections[targetPeerId].streams.map((stream, index) => {
    return new Promise((resolve, reject) => {
      const startChunk = index * chunksPerStream;
      const endChunk = Math.min((index + 1) * chunksPerStream, totalChunks);
      const startOffset = startChunk * CHUNK_SIZE;
      const endOffset = Math.min(endChunk * CHUNK_SIZE, fileSize);
      
      if (startOffset >= endOffset) {
        resolve(); // 没有数据需要这个流传输
        return;
      }
      
      const transfer = {
        file: file,
        fileId: fileId,
        offset: startOffset,
        endOffset: endOffset,
        reader: new FileReader(),
        isSending: false,
        resolve,
        reject,
        streamIndex: index
      };
      
      stream.fileQueue.push(transfer);
      startStreamTransfer(targetPeerId, index);
    });
  });
  
  return Promise.all(transferPromises);
};

// 文件广播函数 (修改后的版本)
const sendFileBroadcast = async () => {
  if (!selectedFile.value) {
    fileTransferError.value = '未选择文件';
    return;
  }
  
  const activePeers = Object.keys(peerConnections).filter(peerId => 
    peerConnections[peerId].streams.some(s => s.dc?.readyState === 'open')
  );
  
  if (activePeers.length === 0) {
    fileTransferError.value = '没有活跃的对等连接';
    return;
  }
  
  fileTransferError.value = '';
  sendFileProgress.value = 0;
  transferStats.speed = 0;
  transferStats.lastBytesSent = 0;
  transferStats.lastTime = Date.now();
  
  try {
    const broadcastPromises = activePeers.map(peerId => 
      sendFileToPeer(peerId, selectedFile.value)
    );
    
    await Promise.all(broadcastPromises);
    sendFileProgress.value = 100;
    console.log(`[${mySessionId.value}] 文件广播完成`);
  } catch (error) {
    console.error(`[${mySessionId.value}] 广播错误:`, error);
    fileTransferError.value = `广播失败: ${error.message}`;
  }
};



















const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB, increased for better throughput, adjust as needed

// Your WebSocket signaling server URL
const wsUrl = 'ws://59.110.35.198/wgk/ws/file';

// --- WebSocket Heartbeat ---
const startHeartbeat = () => {
  console.log(`[${mySessionId.value}] 启动心跳机制...`);
  heartbeatIntervalId.value = setInterval(() => {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      sendMessage({ type: 'ping' });
    }
  }, 30000); // Send ping every 30 seconds
};

const sendMessage = (message) => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify(message));
  } else {
    console.error(`[${mySessionId.value}] 无法发送消息，WebSocket 未连接或已关闭。`);
  }
};

const stopHeartbeat = () => {
  console.log(`[${mySessionId.value}] 停止心跳机制...`);
  if (heartbeatIntervalId.value) {
    clearInterval(heartbeatIntervalId.value);
    heartbeatIntervalId.value = null;
  }
};

// --- WebSocket Signaling Logic ---
const connectWebSocket = () => {
  if (ws.value && (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)) {
      console.log(`[${mySessionId.value}] WebSocket 正在连接或已连接，跳过重复连接。`);
      return;
  }
  ws.value = new WebSocket(wsUrl);

  ws.value.onopen = () => {
    startHeartbeat();
    isWsConnected.value = true;
    console.log(`[${mySessionId.value}] WebSocket 连接成功！`);
  };

  ws.value.onmessage = async (event) => {
    const message = event.data;

    if (message === 'pong') {
      // console.log(`[${mySessionId.value}] 收到 pong`);
      return;
    }

    try {
      const parsedMessage = JSON.parse(message);

      if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        console.log(`[${mySessionId.value}] 我的会话ID:`, mySessionId.value);
        return;
      }

      if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        const onlinePeers = parsedMessage.users.filter(id => id !== mySessionId.value);
        const currentConnectedPeers = Object.keys(peerConnections);

        // Create new connections for newly online peers
        onlinePeers.forEach(peerId => {
          if (!currentConnectedPeers.includes(peerId) && !peerConnections[peerId]) {
            // Only one side should create the offer to avoid collision
            if (mySessionId.value < peerId) { // Lexicographical comparison
              console.log(`[${mySessionId.value}] 检测到新用户 ${peerId}，创建 Offer...`);
              createOffer(peerId);
            } else {
              console.log(`[${mySessionId.value}] 用户 ${peerId} 上线，等待其创建 Offer...`);
              // Create a placeholder PC object so `peerConnections` tracks this peer
              if (!peerConnections[peerId]) {
                  peerConnections[peerId] = { pc: null, dc: null, fileQueue: [] };
              }
            }
          }
        });

        // Close connections for peers that have gone offline
        currentConnectedPeers.forEach(peerId => {
          if (!onlinePeers.includes(peerId)) {
            console.log(`[${mySessionId.value}] 用户 ${peerId} 已离线，关闭连接。`);
            closePeerConnection(peerId);
          }
        });
        return;
      }

      const fromId = parsedMessage.from;
      if (!fromId) {
        console.error(`[${mySessionId.value}] 收到无 'from' 字段的信令消息:`, parsedMessage);
        return;
      }

      if (parsedMessage.type === 'offer') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 Offer.`);
        await handleOffer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'answer') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer.`);
        await handleAnswer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'candidate') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 ICE Candidate.`);
        await handleCandidate(parsedMessage.candidate, fromId);
      } else if (parsedMessage.type === 'user-left') {
        console.log(`[${mySessionId.value}] 信令服务器通知用户 ${fromId} 离开，关闭连接。`);
        closePeerConnection(fromId);
      } else {
        console.warn(`[${mySessionId.value}] 收到意外的信令消息类型来自 ${fromId}: ${JSON.stringify(parsedMessage)}`);
      }
    } catch (e) {
      console.error(`[${mySessionId.value}] 处理WS消息出错: ${message}. 错误: ${e.message}`, e);
    }
  };

  ws.value.onclose = () => {
    console.log(`[${mySessionId.value}] WebSocket 连接关闭。尝试重新连接...`);
    isWsConnected.value = false;
    stopHeartbeat();
    // Close all peer connections on WebSocket close
    Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
    setTimeout(connectWebSocket, 5000); // Attempt to reconnect after 5 seconds
  };

  ws.value.onerror = (error) => {
    console.error(`[${mySessionId.value}] WebSocket 错误: ${error.message || error}`);
    ws.value.close(); // Close connection, which will trigger onclose and retry
  };
};

// --- WebRTC Peer Connection Logic ---
const createPeerConnection = (targetPeerId, isOfferer = true) => {
  // Check if PC already exists and is not closed/failed
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
    peerConnections[targetPeerId].pc.connectionState !== 'closed' &&
    peerConnections[targetPeerId].pc.iceConnectionState !== 'failed' &&
    peerConnections[targetPeerId].pc.iceConnectionState !== 'disconnected') {
    console.log(`[${mySessionId.value}] 与 ${targetPeerId} 的 PeerConnection 已存在且有效，复用。`);
    return peerConnections[targetPeerId].pc;
  }

  console.log(`[${mySessionId.value}] 为 ${targetPeerId} 创建新的 RTCPeerConnection.`);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetPeerId] = { pc: pc, dc: null, fileQueue: [] }; // Ensure fileQueue is initialized

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      // console.log(`[${mySessionId.value}] 发送 ICE Candidate 给 ${targetPeerId}`, event.candidate);
      sendSignalingMessage('candidate', { candidate: event.candidate }, targetPeerId);
    } else {
      console.log(`[${mySessionId.value}] ICE Candidate 收集完毕 for ${targetPeerId}.`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${mySessionId.value}] ICE 连接状态 for ${targetPeerId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.warn(`[${mySessionId.value}] ICE 连接状态变为 ${pc.iceConnectionState}，尝试关闭与 ${targetPeerId} 的连接。`);
      closePeerConnection(targetPeerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${mySessionId.value}] WebRTC 连接状态 for ${targetPeerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      console.warn(`[${mySessionId.value}] WebRTC 连接状态变为 ${pc.connectionState}，尝试关闭与 ${targetPeerId} 的连接。`);
      closePeerConnection(targetPeerId);
    }
  };

  pc.ondatachannel = (event) => {
    console.log(`[${mySessionId.value}] 收到来自 ${targetPeerId} 的 DataChannel: ${event.channel.label}`);
    peerConnections[targetPeerId].dc = event.channel;
    setupDataChannelListeners(event.channel, targetPeerId);
  };

  if (isOfferer) {
    console.log(`[${mySessionId.value}] 为 ${targetPeerId} 创建 DataChannel.`);
    // IMPORTANT: Remove maxRetransmits: 0 to enable reliable transfer
    const dc = pc.createDataChannel("file-transfer-channel", {
      ordered: true, // Guarantees order
      // maxRetransmits: 0 // <--- REMOVE THIS LINE for reliable transfer
    });
    peerConnections[targetPeerId].dc = dc;
    setupDataChannelListeners(dc, targetPeerId);
  }
  return pc;
};

// Function to concatenate an array of ArrayBuffers (handling sparse arrays for potential missing chunks)
const concatenateArrayBuffers = (buffers) => {
  let totalLength = 0;
  // Ensure we iterate through the actual indices where buffers are present
  // DataChannel `ordered: true` means chunks should arrive in order,
  // but if `maxRetransmits: 0` was used (which we removed), chunks could be missing.
  // With `ordered: true` and default reliable, this should be a dense array.
  for (let i = 0; i < buffers.length; i++) {
    if (buffers[i]) { // Check if the chunk is not null/undefined
      totalLength += buffers[i].byteLength;
    } else {
        // This case should ideally not happen with reliable ordered DataChannels
        console.warn(`[${mySessionId.value}] Missing chunk at index ${i} during concatenation.`);
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < buffers.length; i++) {
    if (buffers[i]) {
      result.set(new Uint8Array(buffers[i]), offset);
      offset += buffers[i].byteLength;
    }
  }
  return result.buffer;
};

const closePeerConnection = (peerId) => {
  if (peerConnections[peerId]) {
    console.log(`[${mySessionId.value}] 关闭与 ${peerId} 的 PeerConnection.`);
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
    console.error(`[${mySessionId.value}] 无法发送信令消息给 ${toId}: WS 未打开或缺少目标 for ${type}.`);
  }
};

const createOffer = async (targetPeerId) => {
  const pc = createPeerConnection(targetPeerId, true);
  if (!pc) {
    console.error(`[${mySessionId.value}] 无法为 ${targetPeerId} 创建 PeerConnection，跳过创建 Offer。`);
    return;
  }
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingMessage('offer', { sdp: offer }, targetPeerId);
    console.log(`[${mySessionId.value}] 已创建并发送 Offer 给 ${targetPeerId}.`);
  } catch (error) {
    console.error(`[${mySessionId.value}] 创建 Offer 失败 for ${targetPeerId}: ${error.message}`, error);
  }
};

const handleOffer = async (sdp, fromId) => {
  const pc = createPeerConnection(fromId, false);
  if (!pc) {
      console.error(`[${mySessionId.value}] 无法为 ${fromId} 创建 PeerConnection 来处理 Offer。`);
      return;
  }
  try {
    console.log(`[${mySessionId.value}] 设置远程描述 (Offer) from ${fromId}.`);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    console.log(`[${mySessionId.value}] 设置本地描述 (Answer) for ${fromId}.`);
    await pc.setLocalDescription(answer);
    sendSignalingMessage('answer', { sdp: answer }, fromId);
    console.log(`[${mySessionId.value}] 已创建并发送 Answer 给 ${fromId}.`);
  } catch (error) {
    console.error(`[${mySessionId.value}] 处理 Offer 失败 from ${fromId}: ${error.message}`, error);
  }
};

const handleAnswer = async (sdp, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer 但没有对应的 PeerConnection。`);
    return;
  }
  try {
    if (pcInfo.pc.signalingState !== 'have-local-offer') {
      console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer，但信令状态为 ${pcInfo.pc.signalingState}。期望 'have-local-offer'。`);
    }
    console.log(`[${mySessionId.value}] 设置远程描述 (Answer) from ${fromId}.`);
    await pcInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    console.error(`[${mySessionId.value}] 处理 Answer 失败 from ${fromId}: ${error.message}`, error);
  }
};

const handleCandidate = async (candidate, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 ICE Candidate 但没有对应的 PeerConnection。`);
    return;
  }
  try {
    console.log(`[${mySessionId.value}] 添加 ICE Candidate for ${fromId}.`);
    await pcInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error(`[${mySessionId.value}] 添加 ICE Candidate 失败 for ${fromId}: ${error.message}. (可能是重复或无效的候选者)`, error);
  }
};

// --- File Selection & Broadcasting Logic ---
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendFileProgress.value = 0;
  fileTransferError.value = '';
  console.log(`[${mySessionId.value}] 文件已选择: ${selectedFile.value ? selectedFile.value.name : '无'}`);
};


const readNextChunk = (fileTransferState) => {
  const { file, offset, reader, fileId, targetPeerId } = fileTransferState;
  const pcInfo = peerConnections[targetPeerId];
  const dc = pcInfo ? pcInfo.dc : null;

  if (!dc || dc.readyState !== 'open') {
    console.error(`[${mySessionId.value}] DataChannel for ${targetPeerId} 已关闭或不存在在 readNextChunk 中。状态: ${dc ? dc.readyState : 'null'}. 停止发送。`);
    fileTransferState.isSending = false;
    fileTransferState.reject(new Error(`DataChannel for ${targetPeerId} closed unexpectedly during transfer.`));
    // Remove from queue
    if (pcInfo && pcInfo.fileQueue[0] === fileTransferState) {
        pcInfo.fileQueue.shift();
    }
    return;
  }

  if (offset >= file.size) {
      // All chunks sent, send completion signal
      const completeSignalPayload = JSON.stringify({
          type: 'file-transfer-complete-signal',
          fileId: fileId,
          fileName: file.name,
          from: mySessionId.value
      });
      try {
          dc.send(completeSignalPayload); // Send completion signal
          console.log(`[${mySessionId.value}] 文件 ${file.name} (ID: ${fileId}) 发送完成信号给 ${targetPeerId}.`);
      } catch (e) {
          console.error(`[${mySessionId.value}] 无法发送完成信号给 ${targetPeerId}: ${e.message}`, e);
      }

      fileTransferState.isSending = false;
      // Remove this completed file from the queue
      if (pcInfo.fileQueue[0] === fileTransferState) {
          pcInfo.fileQueue.shift();
      }
      fileTransferState.resolve(); // Resolve the Promise for this file transfer

      // Check if there are other files in the queue for this peer
      if (pcInfo.fileQueue.length > 0) {
          const nextFileTransfer = pcInfo.fileQueue[0];
          console.log(`[${mySessionId.value}] 队列中有其他文件，开始发送下一个: ${nextFileTransfer.file.name} 给 ${targetPeerId}.`);
          nextFileTransfer.isSending = true;
          // Ensure metadata for the next file is sent if it wasn't already
          const metadata = {
            type: 'file-metadata-signal',
            fileId: nextFileTransfer.fileId,
            fileName: nextFileTransfer.file.name,
            fileType: nextFileTransfer.file.type || 'application/octet-stream',
            fileSize: nextFileTransfer.file.size,
            from: mySessionId.value
          };
          try {
              dc.send(JSON.stringify(metadata));
              console.log(`[${mySessionId.value}] Sent metadata for next queued file ${nextFileTransfer.fileId} to ${targetPeerId}.`);
          } catch (e) {
              console.error(`[${mySessionId.value}] Failed to send metadata for next file in queue: ${e.message}`);
              nextFileTransfer.reject(e); // Reject this file transfer
              pcInfo.fileQueue.shift(); // Remove problematic file
              // Attempt to continue with the next if any
              if (pcInfo.fileQueue.length > 0) {
                  readNextChunk(pcInfo.fileQueue[0]);
              }
              return;
          }
          readNextChunk(nextFileTransfer);
      }
      return;
  }

  const slice = file.slice(offset, offset + CHUNK_SIZE);
  reader.readAsArrayBuffer(slice);

  reader.onload = (e) => {
    const chunk = e.target.result;
    const fileIdBytes = new TextEncoder().encode(fileId);
    // Header format: [fileIdLen (1 byte)][fileId (variable)][chunkIndex (4 bytes)][isLastChunkFlag (1 byte)]
    const header = new Uint8Array(1 + fileIdBytes.byteLength + 4 + 1);
    let headerOffset = 0;

    header[headerOffset++] = fileIdBytes.byteLength;
    header.set(fileIdBytes, headerOffset);
    headerOffset += fileIdBytes.byteLength;

    const chunkIndex = Math.floor(offset / CHUNK_SIZE);
    new DataView(header.buffer).setUint32(headerOffset, chunkIndex, true); // true for little-endian
    headerOffset += 4;

    // Although not strictly necessary with reliable DataChannel, keep for completeness
    const isLastChunk = (offset + chunk.byteLength) >= file.size;
    header[headerOffset++] = isLastChunk ? 1 : 0;

    const combinedBuffer = new Uint8Array(header.byteLength + chunk.byteLength);
    combinedBuffer.set(header, 0);
    combinedBuffer.set(new Uint8Array(chunk), header.byteLength);

    // Check buffered amount BEFORE sending
    if (dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
      try {
        dc.send(combinedBuffer.buffer);
        fileTransferState.offset += chunk.byteLength;
        // Update global sender progress based on the currently sending file
        sendFileProgress.value = (fileTransferState.offset / file.size) * 100;
        // console.log(`[${mySessionId.value}] Sent chunk ${chunkIndex} for ${fileId} to ${targetPeerId}. Progress: ${sendFileProgress.value.toFixed(2)}%`);

        // If not all data sent, read next chunk
        if (fileTransferState.offset < file.size) {
          // If buffered amount is still low, continue immediately
          if (dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
            readNextChunk(fileTransferState);
          } else {
            // Otherwise, wait for onbufferedamountlow event
            console.log(`[${mySessionId.value}] DataChannel bufferedAmount is high (${dc.bufferedAmount} bytes) for ${targetPeerId}, waiting for onbufferedamountlow.`);
          }
        } else {
          // File fully sent, will be handled by the offset >= file.size check at the start of this function
          // This else block here means the last chunk was just sent.
          console.log(`[${mySessionId.value}] Last chunk for ${fileId} sent to ${targetPeerId}.`);
        }
      } catch (e) {
        console.error(`[${mySessionId.value}] 通过 DataChannel 发送文件块失败给 ${targetPeerId}: ${e.message}`, e);
        fileTransferError.value = `文件发送失败给 ${targetPeerId}: ${e.message}`;
        fileTransferState.isSending = false;
        fileTransferState.reject(e); // Reject Promise on error
        // Remove from queue
        if (pcInfo && pcInfo.fileQueue[0] === fileTransferState) {
            pcInfo.fileQueue.shift();
        }
        // If there are other files in queue, attempt to start the next one
        if (pcInfo.fileQueue.length > 0) {
            readNextChunk(pcInfo.fileQueue[0]);
        }
      }
    } else {
      console.log(`[${mySessionId.value}] DataChannel bufferedAmount already too high (${dc.bufferedAmount} bytes) for ${targetPeerId} before sending. Waiting for onbufferedamountlow.`);
      // The `readNextChunk` call will be triggered by `onbufferedamountlow`
    }
  };

  reader.onerror = (error) => {
    console.error(`[${mySessionId.value}] FileReader 错误 for ${fileId}:`, error);
    fileTransferError.value = '读取文件出错: ' + error.message;
    fileTransferState.isSending = false;
    fileTransferState.reject(error);
    // Remove from queue
    if (pcInfo && pcInfo.fileQueue[0] === fileTransferState) {
        pcInfo.fileQueue.shift();
    }
    // If there are other files in queue, attempt to start the next one
    if (pcInfo.fileQueue.length > 0) {
        readNextChunk(pcInfo.fileQueue[0]);
    }
  };
};









































onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  if (ws.value) {
    ws.value.close();
  }
  Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
  stopHeartbeat(); // Ensure heartbeat is stopped on unmount
});
</script>

<style scoped>
/* 保持 CSS 样式不变 */
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

.my-id,
.connected-peers-count {
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
  text-shadow: 0 0 2px rgba(255, 255, 255, 0.7);
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