<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC 文件传输</h2>

    <div class="connection-status">
      <span :class="wsStatus.class">WebSocket: {{ wsStatus.text }}</span>
      <span class="peers-count">活跃连接: {{ activePeersCount }}</span>
    </div>

    <div class="file-transfer-section">
      <h3>文件发送</h3>
      <input type="file" @change="handleFileSelection" ref="fileInput" />
      <button @click="startFileTransfer" :disabled="!selectedFile || activePeersCount === 0 || isTransferring">
        {{ isTransferring ? '正在发送...' : '极速广播文件' }}
      </button>
      <div v-if="selectedFile" class="file-info">
        <p>已选文件: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
        <p>传输参数: 块大小 {{ formatBytes(currentChunkSize) }} | 缓冲区 {{ formatBytes(currentBufferLimit) }}</p>
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
            <a v-if="file.progress === 100" :href="file.url" :download="file.name" class="download-btn">
              <i class="fa fa-download"></i> 下载
            </a>
          </div>
          <div class="file-progress">
            <div class="progress-bar" :style="{ width: file.progress + '%' }"></div>
            <span class="progress-text">{{ file.progress.toFixed(2) }}%</span>
          </div>
          <p v-if="file.error" class="file-error">{{ file.error }}</p>
        </div>
      </div>
      <p v-else class="empty-message">暂无接收文件</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watchEffect, nextTick } from 'vue';
import { sha256 } from 'js-sha256';

// --- 配置常量 ---
const WS_URL = 'ws://59.110.35.198/wgk/ws/file';
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }];

// 传输参数 - 降低初始值以适应大文件传输
const INITIAL_CHUNK_SIZE = 32 * 1024;  // 初始块大小 32KB
const MIN_CHUNK_SIZE = 4 * 1024;       // 最小块大小 4KB
const MAX_CHUNK_SIZE = 256 * 1024;     // 最大块大小 256KB
const INITIAL_BUFFER_LIMIT = 4 * 1024 * 1024; // 初始缓冲区限制 4MB
const MIN_BUFFER_LIMIT = 1 * 1024 * 1024;     // 最小缓冲区限制 1MB
const MAX_BUFFER_LIMIT = 32 * 1024 * 1024;    // 最大缓冲区限制 32MB

// 超时设置
const ACK_TIMEOUT = 5000;              // ACK超时时间(毫秒)
const MAX_RETRIES = 15;                // 增加最大重试次数到15
const HEARTBEAT_INTERVAL = 25000;      // WebSocket心跳间隔
const CONNECTION_TIMEOUT = 30000;      // 连接超时时间

// 自适应控制
const ADAPTIVE_INTERVAL = 500;         // 加快自适应参数调整间隔(毫秒)
const CONGESTION_THRESHOLD = 0.5;      // 降低拥塞阈值
const UI_UPDATE_INTERVAL = 100;        // 加快UI更新间隔(毫秒)

// 大文件处理参数
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB定义为大文件
const LARGE_FILE_CHUNK_SIZE = 16 * 1024;       // 大文件使用更小的块大小
const LARGE_FILE_BUFFER_LIMIT = 2 * 1024 * 1024; // 大文件使用更小的缓冲区限制

// --- 状态管理 ---
const ws = ref(null);
const mySessionId = ref('');
const selectedFile = ref(null);
const errorMessage = ref('');
const isTransferring = ref(false);

// 对等连接管理
const peerConnections = reactive({});

// 传输状态
const outgoingTransfers = reactive({});
const incomingFiles = reactive({});
const receivedFiles = reactive([]);

// 性能指标
const totalBytesSent = ref(0);
const lastSpeedCalcTime = ref(0);
const lastBytesSentForSpeed = ref(0);
const currentSendSpeed = ref(0);
const sendProgress = ref(0);
const estimatedProgress = ref(0); // 估算进度（不依赖ACK）

// 自适应传输参数
const currentChunkSize = ref(INITIAL_CHUNK_SIZE);
const currentBufferLimit = ref(INITIAL_BUFFER_LIMIT);
const congestionRate = ref(0);
const recentBufferFullEvents = ref(0);
const isLargeFile = ref(false);

// --- 工具函数 ---
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

const generateUniqueId = () => {
  return `${mySessionId.value}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// 计算文件哈希值
const calculateFileHash = async (file) => {
  return new Promise((resolve, reject) => {
    const chunkSize = 1024 * 1024; // 1MB 块大小
    const chunks = Math.ceil(file.size / chunkSize);
    let currentChunk = 0;
    const sha256Instance = sha256.create();
    
    const loadNextChunk = () => {
      const start = currentChunk * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      
      const reader = new FileReader();
      reader.onload = (e) => {
        sha256Instance.update(new Uint8Array(e.target.result));
        currentChunk++;
        
        if (currentChunk < chunks) {
          loadNextChunk();
        } else {
          resolve(sha256Instance.hex());
        }
      };
      
      reader.onerror = (e) => {
        reject(new Error(`计算哈希值失败: ${e.target.error.message}`));
      };
      
      reader.readAsArrayBuffer(file.slice(start, end));
    };
    
    loadNextChunk();
  });
};

// --- 文件选择和传输 ---
const handleFileSelection = (event) => {
  selectedFile.value = event.target.files[0];
  errorMessage.value = '';
  sendProgress.value = 0;
  estimatedProgress.value = 0;
  totalBytesSent.value = 0;
  currentSendSpeed.value = 0;
  isTransferring.value = false;
  
  // 重置自适应参数
  isLargeFile.value = selectedFile.value && selectedFile.value.size > LARGE_FILE_THRESHOLD;
  currentChunkSize.value = isLargeFile.value ? LARGE_FILE_CHUNK_SIZE : INITIAL_CHUNK_SIZE;
  currentBufferLimit.value = isLargeFile.value ? LARGE_FILE_BUFFER_LIMIT : INITIAL_BUFFER_LIMIT;
  congestionRate.value = 0;
  recentBufferFullEvents.value = 0;
  
  // 清理现有传输
  Object.keys(outgoingTransfers).forEach(fileId => {
    const transfer = outgoingTransfers[fileId];
    if (!transfer.isComplete && transfer.reject) {
      transfer.reject(new Error('选择了新文件，传输已取消'));
    }
    delete outgoingTransfers[fileId];
  });
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
  estimatedProgress.value = 0;

  const file = selectedFile.value;
  const fileId = generateUniqueId();
  
  // 计算文件哈希值
  let fileHash;
  try {
    fileHash = await calculateFileHash(file);
  } catch (error) {
    console.error('计算文件哈希值失败:', error);
    errorMessage.value = '文件准备失败，请重试';
    isTransferring.value = false;
    return;
  }

  // 初始化传输状态
  const currentTransfer = {
    file,
    fileId,
    fileHash,
    totalChunks: Math.ceil(file.size / currentChunkSize.value),
    sentChunks: new Map(), // 存储每个块的发送状态
    ackedChunks: new Set(), // 已确认接收的块
    pendingAcks: new Map(), // 等待确认的块
    peers: {}, // 每个对等端的传输状态
    transferStartTime: Date.now(),
    isComplete: false,
    resolve: null,
    reject: null,
    bytesSent: 0,
    chunksProcessed: 0,
    lastBufferCheckTime: Date.now(),
    bufferFullEvents: 0,
    speedHistory: [], // 存储最近的速度数据
    lastProgressUpdate: 0, // 上次更新进度的时间
    estimatedProgress: 0, // 估算进度
    isLargeFile: isLargeFile.value
  };

  outgoingTransfers[fileId] = currentTransfer;

  const transferPromise = new Promise((resolve, reject) => {
    currentTransfer.resolve = resolve;
    currentTransfer.reject = reject;
  });

  // 为每个对等端设置传输
  activePeers.forEach(peerId => {
    const peerTransfer = {
      readQueue: [],
      isPeerComplete: false,
      lastAckTime: Date.now(),
      sendInProgress: false,
      consecutiveFailures: 0,
      bufferStatus: {
        checks: 0,
        full: 0
      },
      lastRetryTime: 0, // 上次重试的时间
      retryBackoff: 100, // 重试退避时间(毫秒)
      maxRetryBackoff: 2000, // 最大重试退避时间
      reconnectionAttempts: 0, // 重连尝试次数
      lastConnectionAttempt: 0 // 上次重连尝试时间
    };
    currentTransfer.peers[peerId] = peerTransfer;

    // 发送元数据
    const dc = peerConnections[peerId]?.dataChannel;
    if (dc?.readyState === 'open') {
      sendMetaData(dc, fileId, file.name, file.size, file.type || 'application/octet-stream', fileHash);
      processOutgoingQueue(fileId, peerId);
    }
  });

  try {
    await transferPromise;
    console.log('文件传输成功完成!');
    errorMessage.value = '';
    sendProgress.value = 100;
    estimatedProgress.value = 100;
  } catch (error) {
    console.error('文件传输失败:', error);
    errorMessage.value = `文件传输失败: ${error.message}`;
  } finally {
    isTransferring.value = false;
  }
};

// --- 数据通道管理 ---
const createDataPacket = (fileId, chunkIndex, chunkData) => {
  // 数据包格式: [文件ID长度][文件ID][块索引][数据]
  const fileIdBytes = new TextEncoder().encode(fileId);
  const header = new Uint8Array(1 + fileIdBytes.length + 4);
  
  let offset = 0;
  header[offset++] = fileIdBytes.length;
  header.set(fileIdBytes, offset);
  offset += fileIdBytes.length;
  
  // 写入块索引
  new DataView(header.buffer).setUint32(offset, chunkIndex, true);
  
  // 创建完整数据包
  const packet = new Uint8Array(header.length + chunkData.byteLength);
  packet.set(header, 0);
  packet.set(new Uint8Array(chunkData), header.length);
  
  return packet.buffer;
};

const processOutgoingQueue = async (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const peerTransfer = transfer.peers[peerId];
  if (!peerTransfer || peerTransfer.isPeerComplete || peerTransfer.sendInProgress) return;

  const peerConn = peerConnections[peerId];
  const dc = peerConn?.dataChannel;

  if (!dc || dc.readyState !== 'open') return;

  // 检查缓冲区状态
  const now = Date.now();
  if (now - transfer.lastBufferCheckTime > 1000) {
    transfer.lastBufferCheckTime = now;
    transfer.bufferFullEvents = 0;
  }
  
  // 更严格的缓冲区检查 - 只在缓冲区使用低于70%时发送
  const bufferUsage = dc.bufferedAmount / currentBufferLimit.value;
  if (bufferUsage > 0.7) {
    transfer.bufferFullEvents++;
    recentBufferFullEvents.value++;
    
    // 对于大文件，更保守地处理缓冲区
    if (transfer.isLargeFile && bufferUsage > 0.8) {
      // 使用指数退避策略，等待后再重试
      setTimeout(() => {
        peerTransfer.sendInProgress = false;
        processOutgoingQueue(fileId, peerId);
      }, 50 + Math.random() * 100); // 随机延迟以避免同步重试
      return;
    }
  }

  peerTransfer.sendInProgress = true;

  try {
    // 查找下一个要发送的块
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

      // 使用File.slice()和FileReader进行内存管理
      const slice = transfer.file.slice(start, end);

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const chunkData = e.target.result;
          const packet = createDataPacket(fileId, nextChunkIndex, chunkData);

          // 发送数据包
          const sendStartTime = Date.now();
          dc.send(packet);

          // 更新发送状态
          transfer.sentChunks.set(nextChunkIndex, {
            timestamp: sendStartTime,
            retries: 0,
            data: packet,
            peerId
          });
          
          transfer.pendingAcks.set(nextChunkIndex, {
            timestamp: sendStartTime,
            retries: 0,
            data: packet
          });

          // 更新统计信息
          transfer.bytesSent += slice.size;
          totalBytesSent.value += slice.size;
          transfer.chunksProcessed++;
          
          // 更新估算进度（不依赖ACK）
          const now = Date.now();
          if (now - transfer.lastProgressUpdate > UI_UPDATE_INTERVAL) {
            transfer.lastProgressUpdate = now;
            transfer.estimatedProgress = Math.min((transfer.chunksProcessed / transfer.totalChunks) * 100, 100);
            estimatedProgress.value = transfer.estimatedProgress;
          }

          // 继续处理队列
          setTimeout(() => {
            peerTransfer.sendInProgress = false;
            processOutgoingQueue(fileId, peerId);
          }, 1);

        } catch (sendError) {
          console.error(`向 ${peerId} 发送块 ${nextChunkIndex} 时出错:`, sendError);
          peerTransfer.consecutiveFailures++;
          
          // 更智能的失败处理
          if (peerTransfer.consecutiveFailures > 3) {
            // 退避重试，避免立即重连
            peerTransfer.retryBackoff = Math.min(
              peerTransfer.retryBackoff * 2,
              peerTransfer.maxRetryBackoff
            );
            
            setTimeout(() => {
              peerTransfer.sendInProgress = false;
              peerTransfer.consecutiveFailures = 0;
              processOutgoingQueue(fileId, peerId);
            }, peerTransfer.retryBackoff);
          } else {
            peerTransfer.sendInProgress = false;
            processOutgoingQueue(fileId, peerId);
          }
        }
      };

      reader.onerror = (e) => {
        console.error(`文件读取器错误，块 ${nextChunkIndex}:`, e.target.error);
        peerTransfer.sendInProgress = false;
      };

      reader.readAsArrayBuffer(slice);
    } else {
      peerTransfer.sendInProgress = false;
      // 检查传输是否完成
      if (transfer.ackedChunks.size === transfer.totalChunks && !peerTransfer.isPeerComplete) {
        sendCompletionMessage(dc, fileId);
        peerTransfer.isPeerComplete = true;
        checkOverallTransferCompletion(fileId);
      }
    }
  } catch (error) {
    console.error(`处理输出队列时出错，对等端 ${peerId}:`, error);
    peerTransfer.sendInProgress = false;
    peerTransfer.consecutiveFailures++;
  }
};

// --- 消息处理 ---
const sendWsMessage = (type, data = {}, to = null) => {
  if (ws.value?.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket未打开，无法发送消息:', type);
    return;
  }
  try {
    const message = { type, ...data };
    if (to) message.to = to;
    ws.value.send(JSON.stringify(message));
  } catch (error) {
    console.error('发送WebSocket消息时出错:', error);
  }
};

const sendMetaData = (dc, fileId, name, size, type, hash) => {
  const metadata = {
    type: 'file-metadata',
    fileId: fileId,
    name: name,
    size: size,
    fileType: type,
    chunkSize: currentChunkSize.value,
    hash: hash,
    totalChunks: Math.ceil(size / currentChunkSize.value),
    isLargeFile: isLargeFile.value
  };
  try {
    dc.send(JSON.stringify(metadata));
    console.log(`向对等端通过数据通道发送文件 ${fileId} (${name}) 的元数据`);
  } catch (e) {
    console.error('发送元数据时出错:', e);
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
    console.error('发送完成消息时出错:', e);
  }
};

const checkOverallTransferCompletion = (fileId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer || transfer.isComplete) return;

  const allPeersComplete = Object.values(transfer.peers).every(p => p.isPeerComplete);
  if (allPeersComplete) {
    transfer.isComplete = true;
    console.log(`文件传输完成: ${transfer.file.name} (${formatBytes(transfer.file.size)})`);
    console.log(`传输时间: ${(Date.now() - transfer.transferStartTime) / 1000} 秒`);
    console.log(`平均速度: ${formatSpeed(transfer.bytesSent / ((Date.now() - transfer.transferStartTime) / 1000))}`);
    
    if (transfer.resolve) transfer.resolve();
  }
};

const handleChunkAck = (fileId, chunkIndex, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (!transfer) return;
  
  const pendingAck = transfer.pendingAcks.get(chunkIndex);
  if (pendingAck) {
    // 计算RTT
    const rtt = Date.now() - pendingAck.timestamp;
    
    // 更新传输统计
    const peerTransfer = transfer.peers[peerId];
    if (peerTransfer) {
      peerTransfer.lastAckTime = Date.now();
      peerTransfer.consecutiveFailures = 0;
      peerTransfer.retryBackoff = 100; // 重置重试退避
    }
    
    transfer.ackedChunks.add(chunkIndex);
    transfer.pendingAcks.delete(chunkIndex);
    
    // 继续处理队列
    processOutgoingQueue(fileId, peerId);
  }
};

// --- UI更新 ---
const updateSendProgress = () => {
  const now = Date.now();
  const timeDiffSeconds = (now - lastSpeedCalcTime.value) / 1000;

  if (timeDiffSeconds >= (UI_UPDATE_INTERVAL / 1000)) {
    const bytesDiff = totalBytesSent.value - lastBytesSentForSpeed.value;
    currentSendSpeed.value = bytesDiff / timeDiffSeconds;
    
    // 保存速度历史记录
    const currentTransfer = Object.values(outgoingTransfers).find(t => !t.isComplete);
    if (currentTransfer) {
      currentTransfer.speedHistory.push({
        time: now,
        speed: currentSendSpeed.value
      });
      
      // 保留最近10秒的数据
      currentTransfer.speedHistory = currentTransfer.speedHistory.filter(
        entry => now - entry.time < 10000
      );
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
        // 优先使用确认的进度，但在ACK不足时使用估算进度
        if (completedChunks > 0) {
          sendProgress.value = Math.min((completedChunks / totalChunks) * 100, 100);
        } else {
          // 当没有确认的块时，使用估算进度（基于已发送的块）
          sendProgress.value = currentFileTransfer.estimatedProgress;
        }
      }
    }
  }
};

// --- 自适应传输参数调整 ---
const adjustTransferParameters = () => {
  if (!isTransferring.value) return;
  
  // 计算拥塞率
  const now = Date.now();
  congestionRate.value = recentBufferFullEvents.value / Math.max(1, Object.values(outgoingTransfers).length);
  recentBufferFullEvents.value = 0;
  
  // 根据拥塞率调整传输参数
  if (congestionRate.value > CONGESTION_THRESHOLD) {
    // 高拥塞 - 减少块大小和缓冲区限制
    currentChunkSize.value = Math.max(
      MIN_CHUNK_SIZE,
      Math.floor(currentChunkSize.value * 0.7)
    );
    currentBufferLimit.value = Math.max(
      MIN_BUFFER_LIMIT,
      Math.floor(currentBufferLimit.value * 0.8)
    );
  } else if (congestionRate.value < 0.2) {
    // 低拥塞 - 增加块大小和缓冲区限制
    currentChunkSize.value = Math.min(
      MAX_CHUNK_SIZE,
      Math.floor(currentChunkSize.value * 1.1)
    );
    currentBufferLimit.value = Math.min(
      MAX_BUFFER_LIMIT,
      Math.floor(currentBufferLimit.value * 1.05)
    );
  }
  
  // 更新所有传输的块大小
  Object.values(outgoingTransfers).forEach(transfer => {
    if (!transfer.isComplete) {
      transfer.totalChunks = Math.ceil(transfer.file.size / currentChunkSize.value);
    }
  });
};

// --- 重传机制 ---
const checkAndRetransmit = () => {
  const now = Date.now();
  
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (transfer.isComplete) continue;
    
    transfer.pendingAcks.forEach((pendingAck, chunkIndex) => {
      // 检查ACK是否超时
      if (now - pendingAck.timestamp > ACK_TIMEOUT) {
        if (pendingAck.retries < MAX_RETRIES) {
          // 查找可以重传的对等端
          let retransmitted = false;
          
          for (const peerId in transfer.peers) {
            const peer = peerConnections[peerId];
            if (!peer || peer.status !== 'connected') continue;
            
            const dc = peer.dataChannel;
            if (dc?.readyState === 'open' && !transfer.peers[peerId].isPeerComplete) {
              try {
                // 更严格的缓冲区检查 - 只在缓冲区使用低于50%时重传
                if (dc.bufferedAmount < currentBufferLimit.value * 0.5) {
                  dc.send(pendingAck.data);
                  pendingAck.timestamp = now;
                  pendingAck.retries++;
                  retransmitted = true;
                  break;
                }
              } catch (e) {
                console.error(`向 ${peerId} 重传块 ${chunkIndex} 时出错:`, e);
              }
            }
          }
          
          // 如果没有找到可用的对等端，增加重试计数
          if (!retransmitted) {
            pendingAck.retries++;
          }
        } else {
          // 达到最大重试次数，标记为已确认但记录错误
          console.warn(`块 ${chunkIndex} 达到最大重试次数，标记为已确认`);
          transfer.ackedChunks.add(chunkIndex);
          transfer.pendingAcks.delete(chunkIndex);
        }
      }
    });
  }
};

// --- WebSocket和WebRTC管理 ---
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
    console.log('WebSocket连接已建立');
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
      console.error('处理WebSocket消息时出错:', error);
    }
  };

  ws.value.onclose = () => {
    console.log('WebSocket连接已关闭。正在重新连接...');
    stopHeartbeat();
    Object.keys(peerConnections).forEach(closePeerConnection);
    setTimeout(connectWebSocket, 5000);
  };

  ws.value.onerror = (error) => {
    console.error('WebSocket错误:', error);
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
    console.error('处理信令offer时出错:', error);
    closePeerConnection(from);
  }
};

const handleSignalingAnswer = async (sdp, from) => {
  const pc = peerConnections[from]?.connection;
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    console.error('处理信令answer时出错:', error);
    closePeerConnection(from);
  }
};

const handleSignalingCandidate = async (candidate, from) => {
  const pc = peerConnections[from]?.connection;
  if (!pc) return;

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error('处理ICE候选者时出错:', error);
  }
};

const createPeerConnection = (peerId) => {
  if (peerConnections[peerId]) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[peerId] = {
    connection: pc,
    status: 'connecting',
    dataChannel: null,
    lastActivity: Date.now(),
    stats: {
      bytesSent: 0,
      bytesReceived: 0,
      messagesSent: 0,
      messagesReceived: 0
    }
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
    } else if (state === 'connected') {
      peerConnections[peerId].status = 'connected';
      console.log(`与 ${peerId} 的连接已建立`);
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

const createOffer = async (peerId) => {
  const pc = peerConnections[peerId]?.connection;
  if (!pc) return;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWsMessage('offer', { sdp: offer, to: peerId });
  } catch (error) {
    console.error('创建offer时出错:', error);
    closePeerConnection(peerId);
  }
};

const closePeerConnection = (peerId) => {
  const peer = peerConnections[peerId];
  if (!peer) return;

  // 关闭连接
  if (peer.connection) {
    peer.connection.close();
  }

  // 清理状态
  peer.status = 'disconnected';
  delete peerConnections[peerId];

  // 清理进行中的传输
  for (const fileId in outgoingTransfers) {
    const transfer = outgoingTransfers[fileId];
    if (transfer.peers[peerId]) {
      delete transfer.peers[peerId];

      // 检查是否所有对等端都断开
      if (Object.keys(transfer.peers).length === 0 && !transfer.isComplete) {
        // 尝试恢复传输
        if (transfer.reject) {
          // 延迟拒绝，给重连一些时间
          setTimeout(() => {
            if (!transfer.isComplete && Object.keys(transfer.peers).length === 0) {
              transfer.reject(new Error('传输过程中所有对等端断开连接'));
              delete outgoingTransfers[fileId];
            }
          }, 10000); // 10秒后检查
        }
      }
    }
  }

  console.log(`已关闭与对等端 ${peerId} 的连接`);
};

// --- 数据通道消息处理 ---
const setupDataChannel = (dc, peerId) => {
  const peer = peerConnections[peerId];
  peer.dataChannel = dc;
  
  dc.onopen = () => {
    peer.status = 'connected';
    peer.lastActivity = Date.now();
    console.log(`与 ${peerId} 的数据通道已打开`);
    
    // 恢复进行中的传输
    Object.keys(outgoingTransfers).forEach(fileId => {
      const transfer = outgoingTransfers[fileId];
      if (!transfer.isComplete && !transfer.peers[peerId]) {
        const peerTransfer = {
          readQueue: [],
          isPeerComplete: false,
          lastAckTime: Date.now(),
          sendInProgress: false,
          consecutiveFailures: 0,
          bufferStatus: {
            checks: 0,
            full: 0
          },
          lastRetryTime: 0,
          retryBackoff: 100,
          maxRetryBackoff: 2000
        };
        transfer.peers[peerId] = peerTransfer;
        
        // 发送元数据
        sendMetaData(dc, fileId, transfer.file.name, transfer.file.size, 
                    transfer.file.type || 'application/octet-stream', transfer.fileHash);
        processOutgoingQueue(fileId, peerId);
      }
    });
  };
  
  dc.onclose = () => {
    peer.status = 'disconnected';
    console.log(`与 ${peerId} 的数据通道已关闭`);
    
    // 尝试重连
    if (isTransferring.value) {
      console.log(`尝试重新连接到 ${peerId}...`);
      setTimeout(() => {
        if (peerConnections[peerId]?.status !== 'connected') {
          createPeerConnection(peerId);
          createOffer(peerId);
        }
      }, 3000);
    }
  };
  
  dc.onerror = (error) => {
    console.error(`与 ${peerId} 的数据通道错误:`, error);
    closePeerConnection(peerId);
    
    // 尝试重新连接
    if (isTransferring.value) {
      const now = Date.now();
      const peerTransfer = Object.values(outgoingTransfers)
        .find(t => !t.isComplete)?.peers[peerId];
      
      if (!peerTransfer || now - (peerTransfer.lastConnectionAttempt || 0) > 10000) {
        console.log(`数据通道错误后尝试重新连接到 ${peerId}...`);
        setTimeout(() => {
          createPeerConnection(peerId);
          createOffer(peerId);
          if (peerTransfer) {
            peerTransfer.lastConnectionAttempt = now;
            peerTransfer.reconnectionAttempts = (peerTransfer.reconnectionAttempts || 0) + 1;
          }
        }, 5000);
      }
    }
  };
  
  dc.onmessage = (event) => {
    peer.lastActivity = Date.now();
    peer.stats.messagesReceived++;
    
    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        handleDataChannelMessage(msg, peerId);
      } else {
        handleFileChunk(event.data, peerId);
      }
    } catch (error) {
      console.error('处理数据通道消息时出错:', error);
    }
  };
};

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
    case 'ping':
      // 忽略ping消息
      break;
    default:
      console.warn('未知数据通道消息类型:', msg.type);
  }
};

const handleFileMetadata = (metadata, peerId) => {
  const fileId = metadata.fileId;

  // 避免重复接收
  if (incomingFiles[fileId]) return;

  incomingFiles[fileId] = {
    name: metadata.name,
    size: metadata.size,
    type: metadata.fileType,
    hash: metadata.hash,
    receivedChunks: new Map(),
    chunksCount: metadata.totalChunks,
    chunksReceived: 0,
    progress: 0,
    fileId: fileId,
    peerId: peerId,
    startTime: Date.now(),
    completed: false,
    fileData: null,
    isLargeFile: metadata.isLargeFile
  };

  // 添加到接收文件列表
  receivedFiles.push({
    id: fileId,
    name: metadata.name,
    size: metadata.size,
    progress: 0,
    url: '',
    peerId: peerId,
    error: null
  });

  console.log(`正在从 ${peerId} 接收文件 ${metadata.name} (${formatBytes(metadata.size)})`);
};

const handleFileChunk = (data, peerId) => {
  try {
    // 解析头部
    const view = new DataView(data);
    let offset = 0;
    
    const fileIdLength = view.getUint8(offset++);
    const fileId = new TextDecoder().decode(
      data.slice(offset, offset + fileIdLength)
    );
    offset += fileIdLength;
    
    const chunkIndex = view.getUint32(offset, true);
    offset += 4;
    
    // 提取数据
    const chunkData = data.slice(offset);
    
    // 处理文件块
    const fileInfo = incomingFiles[fileId];
    if (!fileInfo) {
      console.warn(`收到未知文件的块: ${fileId}`);
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
      // 对大文件增加ACK发送频率
      if (fileInfo.isLargeFile || Math.random() < 0.8) {
        dc.send(JSON.stringify({
          type: 'chunk-ack',
          fileId: fileId,
          chunkIndex: chunkIndex
        }));
      }
    }
    
    // 检查是否完成
    if (fileInfo.chunksReceived === fileInfo.chunksCount && !fileInfo.completed) {
      finalizeFile(fileId);
    }
  } catch (error) {
    console.error('处理文件块时出错:', error);
  }
};

const handleTransferComplete = (fileId, peerId) => {
  const transfer = outgoingTransfers[fileId];
  if (transfer && transfer.peers[peerId]) {
    transfer.peers[peerId].isPeerComplete = true;
    checkOverallTransferCompletion(fileId);
  }
};

// --- 文件组装 ---
const finalizeFile = async (fileId) => {
  const fileInfo = incomingFiles[fileId];
  if (!fileInfo) return;
  
  try {
    // 按顺序组合块
    const chunks = [];
    let totalSize = 0;
    
    // 先计算总大小
    for (let i = 0; i < fileInfo.chunksCount; i++) {
      const chunk = fileInfo.receivedChunks.get(i);
      if (!chunk) {
        throw new Error(`文件 ${fileInfo.name} 缺少块 ${i}`);
      }
      totalSize += chunk.byteLength;
    }
    
    // 创建ArrayBuffer并填充数据
    const buffer = new Uint8Array(totalSize);
    let position = 0;
    
    for (let i = 0; i < fileInfo.chunksCount; i++) {
      const chunk = fileInfo.receivedChunks.get(i);
      buffer.set(new Uint8Array(chunk), position);
      position += chunk.byteLength;
    }
    
    // 创建Blob
    const blob = new Blob([buffer], { type: fileInfo.type });
    
    // 验证文件完整性
    if (fileInfo.hash) {
      const receivedHash = await calculateFileHash(blob);
      if (receivedHash !== fileInfo.hash) {
        throw new Error(`文件校验失败: 预期 ${fileInfo.hash}, 实际 ${receivedHash}`);
      }
    }
    
    // 创建下载URL
    const url = URL.createObjectURL(blob);
    
    // 更新UI
    const receivedFile = receivedFiles.find(f => f.id === fileId);
    if (receivedFile) {
      receivedFile.progress = 100;
      receivedFile.url = url;
      receivedFile.size = blob.size;
    }
    
    // 标记为已完成
    fileInfo.completed = true;
    fileInfo.fileData = blob;
    
    // 清理临时数据
    delete incomingFiles[fileId];
    
    console.log(`文件 ${fileInfo.name} 接收成功，用时 ${(Date.now() - fileInfo.startTime)/1000} 秒`);
    console.log(`原始大小: ${fileInfo.size}, 接收大小: ${blob.size}`);
  } catch (error) {
    console.error(`完成文件 ${fileInfo.name} 时出错:`, error);
    
    // 更新UI显示错误
    const receivedFile = receivedFiles.find(f => f.id === fileId);
    if (receivedFile) {
      receivedFile.progress = -1; // 错误状态
      receivedFile.error = `文件组装失败: ${error.message}`;
    }
  }
};

// --- 连接监控 ---
const monitorConnections = () => {
  setInterval(() => {
    const now = Date.now();
    
    Object.keys(peerConnections).forEach(peerId => {
      const peer = peerConnections[peerId];
      
      // 检查数据通道活动
      if (peer.status === 'connected' && 
          peer.lastActivity && 
          (now - peer.lastActivity) > CONNECTION_TIMEOUT) {
        console.warn(`与 ${peerId} 超过 ${CONNECTION_TIMEOUT/1000} 秒无活动，关闭连接`);
        closePeerConnection(peerId);
      }
    });
  }, 10000);
};

// --- 定时器管理 ---
let heartbeatIntervalId = null;
let uiUpdateIntervalId = null;
let adaptiveIntervalId = null;
let retransmissionIntervalId = null;

const startTimers = () => {
  // UI更新定时器
  uiUpdateIntervalId = setInterval(updateSendProgress, UI_UPDATE_INTERVAL);
  
  // 自适应参数调整定时器
  adaptiveIntervalId = setInterval(adjustTransferParameters, ADAPTIVE_INTERVAL);
  
  // 重传定时器
  retransmissionIntervalId = setInterval(checkAndRetransmit, ACK_TIMEOUT / 2);
};

const stopTimers = () => {
  if (uiUpdateIntervalId) {
    clearInterval(uiUpdateIntervalId);
    uiUpdateIntervalId = null;
  }
  
  if (adaptiveIntervalId) {
    clearInterval(adaptiveIntervalId);
    adaptiveIntervalId = null;
  }
  
  if (retransmissionIntervalId) {
    clearInterval(retransmissionIntervalId);
    retransmissionIntervalId = null;
  }
};

// --- 计算属性 ---
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

// --- 生命周期钩子 ---
onMounted(() => {
  connectWebSocket();
  startTimers();
  monitorConnections();
});

onUnmounted(() => {
  // 清理资源
  ws.value?.close();
  stopHeartbeat();
  stopTimers();

  // 关闭所有对等连接
  Object.keys(peerConnections).forEach(closePeerConnection);

  // 清理接收文件的URL
  receivedFiles.forEach(file => {
    if (file.url) URL.revokeObjectURL(file.url);
  });
});

// 监听传输状态变化
watchEffect(() => {
  if (isTransferring.value) {
    startTimers();
  } else {
    stopTimers();
  }
});
</script>

<style scoped>
.webrtc-file-transfer-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
  font-family: Arial, sans-serif;
}

.connection-status {
  display: flex;
  justify-content: space-between;
  margin-bottom: 20px;
  padding: 10px;
  background-color: #f8f9fa;
  border-radius: 5px;
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

.file-transfer-section,
.received-files-section {
  margin-bottom: 20px;
  padding: 15px;
  border: 1px solid #eee;
  border-radius: 8px;
}

h2, h3 {
  color: #333;
  margin-top: 0;
}

input[type="file"] {
  margin: 10px 0;
  padding: 5px;
}

button {
  background-color: #4CAF50;
  color: white;
  padding: 10px 15px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.3s;
}

button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

button:hover:not(:disabled) {
  background-color: #45a049;
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
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background-color: #4CAF50;
  border-radius: 10px;
  transition: width 0.3s;
  position: absolute;
  top: 0;
  left: 0;
}

.progress-text,
.speed-indicator {
  position: absolute;
  top: 0;
  color: #333;
  font-size: 12px;
  line-height: 20px;
  padding: 0 10px;
  z-index: 1;
}

.progress-text {
  left: 0;
}

.speed-indicator {
  right: 0;
}

.error-message {
  color: #ff0000;
  margin: 10px 0;
}

.file-list {
  margin-top: 10px;
}

.file-item {
  margin-bottom: 10px;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  transition: box-shadow 0.3s;
}

.file-item:hover {
  box-shadow: 0 2px 5px rgba(0,0,0,0.1);
}

.file-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
}

.file-name {
  font-weight: bold;
}

.file-progress {
  height: 10px;
  background-color: #f0f0f0;
  border-radius: 5px;
  position: relative;
  overflow: hidden;
}

.download-btn {
  color: white;
  background-color: #2196F3;
  padding: 3px 8px;
  border-radius: 3px;
  text-decoration: none;
  font-size: 12px;
  transition: background-color 0.3s;
}

.download-btn:hover {
  background-color: #0b7dda;
}

.file-error {
  color: #ff0000;
  font-size: 12px;
  margin-top: 5px;
}

.empty-message {
  color: #666;
  font-style: italic;
}
</style>
