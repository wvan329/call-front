<template>
  <div class="webrtc-file-transfer-container">
    <h2>WebRTC文件快传</h2>

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

const incomingFileBuffers = {}; // 存放正在接收的文件的分块

// Helper computed property to check if any data channel is open
const isAnyDataChannelOpen = computed(() => {
  return Object.values(peerConnections).some(pcInfo => pcInfo.dc && pcInfo.dc.readyState === 'open');
});

// --- WebRTC Configuration ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:59.110.35.198:3478' }
  ]
};

// --- File Transfer Constants ---
const CHUNK_SIZE = 16 * 1024; // 16KB
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 最大发送缓冲区，例如 64KB

const wsUrl = 'ws://59.110.35.198/wgk/ws/file'; // Your WebSocket signaling server URL

// --- Utility Functions ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

// --- 新增心跳函数 ---
const startHeartbeat = () => {
  console.log('启动心跳机制...');
  heartbeatIntervalId.value = setInterval(() => {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
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
    console.log('WebSocket 连接成功！');
  };

  ws.value.onmessage = async (event) => {
    const message = event.data;

    if (message === 'pong') {
      // console.log('收到 pong'); // 可以根据需要打印
      return;
    }

    try {
      const parsedMessage = JSON.parse(message);

      if (parsedMessage.type === 'session-id' && parsedMessage.id) {
        mySessionId.value = parsedMessage.id;
        console.log('我的会话ID:', mySessionId.value);
        return;
      }

      if (parsedMessage.type === 'user-list' && parsedMessage.users) {
        const onlinePeers = parsedMessage.users.filter(id => id !== mySessionId.value);
        const currentConnectedPeers = Object.keys(peerConnections);

        // 创建新的连接
        onlinePeers.forEach(peerId => {
          if (!currentConnectedPeers.includes(peerId) && !peerConnections[peerId]) {
            // 避免重复创建或创建对等连接
            // 使用mySessionId.value < peerId确保只有一方创建Offer，避免冲突
            if (mySessionId.value < peerId) {
              console.log(`[${mySessionId.value}] 创建与 ${peerId} 的Offer`);
              createOffer(peerId);
            }
          }
        });

        // 关闭已离线的对等连接
        currentConnectedPeers.forEach(peerId => {
          if (!onlinePeers.includes(peerId)) {
            console.log(`[${mySessionId.value}] 关闭与 ${peerId} 的连接 (用户已离线)`);
            closePeerConnection(peerId);
          }
        });
        return;
      }

      const fromId = parsedMessage.from;
      if (!fromId) {
        console.error(`收到无 'from' 字段的消息: ${message}`);
        return;
      }

      if (parsedMessage.type === 'offer') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 Offer`);
        await handleOffer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'answer') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer`);
        await handleAnswer(parsedMessage.sdp, fromId);
      } else if (parsedMessage.type === 'candidate') {
        console.log(`[${mySessionId.value}] 收到来自 ${fromId} 的 ICE Candidate`);
        await handleCandidate(parsedMessage.candidate, fromId);
      } else if (parsedMessage.type === 'user-left') {
        console.log(`[${mySessionId.value}] 用户 ${fromId} 离开，关闭连接`);
        closePeerConnection(fromId);
      } else {
        console.warn(`[${mySessionId.value}] 收到意外的信令消息来自 ${fromId}: ${JSON.stringify(parsedMessage)}`);
      }
    } catch (e) {
      console.error(`处理WS消息出错: ${message}. 错误: ${e.message}`);
    }
  };

  ws.value.onclose = () => {
    console.log('WebSocket 连接关闭。尝试重新连接...');
    isWsConnected.value = false;
    stopHeartbeat();
    Object.keys(peerConnections).forEach(peerId => closePeerConnection(peerId));
    setTimeout(connectWebSocket, 5000); // 5秒后尝试重新连接
  };

  ws.value.onerror = (error) => {
    console.error(`WebSocket 错误: ${error.message || error}`);
    ws.value.close(); // 关闭连接，触发 onclose 尝试重新连接
  };
};

// --- WebRTC Peer Connection Logic ---
const createPeerConnection = (targetPeerId, isOfferer = true) => {
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
    peerConnections[targetPeerId].pc.connectionState !== 'closed' &&
    peerConnections[targetPeerId].pc.iceConnectionState !== 'failed' &&
    peerConnections[targetPeerId].pc.iceConnectionState !== 'disconnected') {
    // Return existing valid connection
    return peerConnections[targetPeerId].pc;
  }

  console.log(`[${mySessionId.value}] 为 ${targetPeerId} 创建新的 RTCPeerConnection`);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetPeerId] = { pc: pc, dc: null, fileQueue: [] }; // 添加 fileQueue 来管理发送队列

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`[${mySessionId.value}] 发送 ICE Candidate 给 ${targetPeerId}`);
      ws.value.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        to: targetPeerId
      }));
    } else {
      console.log(`[${mySessionId.value}] ICE Candidate 收集完毕 for ${targetPeerId}`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${mySessionId.value}] ICE 连接状态 for ${targetPeerId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.warn(`[${mySessionId.value}] ICE 连接状态变为 ${pc.iceConnectionState}，关闭与 ${targetPeerId} 的连接`);
      closePeerConnection(targetPeerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${mySessionId.value}] WebRTC 连接状态 for ${targetPeerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      console.warn(`[${mySessionId.value}] WebRTC 连接状态变为 ${pc.connectionState}，关闭与 ${targetPeerId} 的连接`);
      closePeerConnection(targetPeerId);
    }
  };

  pc.ondatachannel = (event) => {
    console.log(`[${mySessionId.value}] 收到来自 ${targetPeerId} 的 DataChannel: ${event.channel.label}`);
    peerConnections[targetPeerId].dc = event.channel;
    setupDataChannelListeners(event.channel, targetPeerId);
  };

  if (isOfferer) {
    console.log(`[${mySessionId.value}] 为 ${targetPeerId} 创建 DataChannel`);
    // 移除 maxRetransmits: 0，使用默认的可靠传输
    const dc = pc.createDataChannel("file-transfer-channel", {
      ordered: true,
      // maxRetransmits: 0 // <--- 移除此行，让它使用默认的可靠传输
    });
    peerConnections[targetPeerId].dc = dc;
    setupDataChannelListeners(dc, targetPeerId);
  }
  return pc;
};

const setupDataChannelListeners = (channel, peerId) => {
  channel.onopen = () => {
    console.log(`[${peerId}] DataChannel 打开！`);
    fileTransferError.value = '';
    // 如果有文件在队列中，开始发送
    if (peerConnections[peerId] && peerConnections[peerId].fileQueue.length > 0) {
      console.log(`[${peerId}] DataChannel 打开，开始处理文件发送队列。`);
      sendFileChunk(peerId, peerConnections[peerId].fileQueue[0]);
    }
  };

  channel.onclose = () => {
    console.log(`[${peerId}] DataChannel 关闭。`);
    if (peerConnections[peerId]) {
      peerConnections[peerId].dc = null;
    }
  };

  channel.onerror = (error) => {
    console.error(`[${peerId}] DataChannel 错误: ${error.message || error}`);
    // fileTransferError.value = `Error with DataChannel to ${peerId}: ${error.message || error}`; // 接收端不需要设置发送错误
  };

  // 发送端流量控制
  channel.onbufferedamountlow = () => {
    const pcInfo = peerConnections[peerId];
    if (pcInfo && pcInfo.fileQueue.length > 0) {
      const currentFileTransfer = pcInfo.fileQueue[0];
      if (currentFileTransfer.isSending) { // 确保当前正在发送文件
        sendFileChunk(peerId, currentFileTransfer);
      }
    }
  };

  channel.onmessage = async (event) => {
    const receivedData = event.data;

    try {
      if (typeof receivedData === 'string') {
        const parsedData = JSON.parse(receivedData);
        if (parsedData.type === 'file-metadata-signal') {
          const { fileId, fileName, fileType, fileSize, from } = parsedData;
          console.log(`[${mySessionId.value}] 收到文件元数据 for ${fileId}: ${fileName} (${formatBytes(fileSize)})`);
          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: [],
            receivedSize: 0,
            from: from,
            progress: 0,
            index: receivedFiles.length,
            // 额外添加一个Set来跟踪收到的块索引，以便检查完整性 (虽然默认可靠性通常不需要)
            receivedChunkIndices: new Set(),
            totalChunks: Math.ceil(fileSize / CHUNK_SIZE)
          };
          // Vue 响应式数组 push 后，Vue 知道它的存在。
          // 但如果要更新其中的复杂对象属性（比如 progress），需要确保Vue能够追踪到。
          // 这里我们直接push一个响应式对象
          const newFileItem = reactive({
            metadata: { fileName, fileType, fileSize },
            url: null,
            progress: 0,
            index: receivedFiles.length // Keep for reference, but reactive object handles updates
          });
          receivedFiles.push(newFileItem);
          incomingFileBuffers[fileId].reactiveItem = newFileItem; // 引用到响应式对象
        } else if (parsedData.type === 'file-transfer-complete-signal') {
          console.log(`[${mySessionId.value}] 收到文件传输完成信号 for ${parsedData.fileId}`);
          // 确保所有块都已收到，即使 DataChannel 是可靠的，这也是一个好的最终检查
          const fileBuffer = incomingFileBuffers[parsedData.fileId];
          if (fileBuffer && fileBuffer.receivedSize === fileBuffer.metadata.fileSize) {
              console.log(`[${mySessionId.value}] 文件 ${parsedData.fileName} 成功接收并重组。`);
          } else {
              console.warn(`[${mySessionId.value}] 文件 ${parsedData.fileName} 收到完成信号，但大小不匹配或有缺失块。`);
          }
          // 在接收到完成信号后，可以考虑移除 fileBuffer 以释放内存，但我们应该在Blob创建后立即删除
        } else {
          console.warn(`[${mySessionId.value}] DataChannel String (未知类型) from ${peerId}: ${receivedData}`);
        }
      } else if (receivedData instanceof ArrayBuffer) {
        const view = new DataView(receivedData);
        const fileIdLen = view.getUint8(0);
        const fileId = new TextDecoder().decode(receivedData.slice(1, 1 + fileIdLen));
        const chunkIndex = view.getUint32(1 + fileIdLen, true);
        const isLastChunk = view.getUint8(1 + fileIdLen + 4) === 1; // 仅作为参考，实际不用于判断是否最终块
        const chunkData = receivedData.slice(1 + fileIdLen + 4 + 1);

        if (!incomingFileBuffers[fileId]) {
          console.error(`[${mySessionId.value}] 收到未知文件ID的块: ${fileId}. 元数据可能丢失。`);
          return;
        }

        const fileBuffer = incomingFileBuffers[fileId];
        if (fileBuffer.receivedChunkIndices.has(chunkIndex)) {
            // console.warn(`[${mySessionId.value}] 收到重复的块 for fileId ${fileId}, chunkIndex ${chunkIndex}`);
            return; // 忽略重复的块
        }

        fileBuffer.chunks[chunkIndex] = chunkData;
        fileBuffer.receivedSize += chunkData.byteLength;
        fileBuffer.receivedChunkIndices.add(chunkIndex);

        // 更新 Vue 响应式对象
        if (fileBuffer.reactiveItem) {
          fileBuffer.reactiveItem.progress = (fileBuffer.receivedSize / fileBuffer.metadata.fileSize) * 100;
        }

        // 仅在所有块都接收到并且大小匹配时才重组文件
        if (fileBuffer.receivedSize === fileBuffer.metadata.fileSize && fileBuffer.receivedChunkIndices.size === fileBuffer.totalChunks) {
          console.log(`[${mySessionId.value}] 所有块已接收 for ${fileId}，开始重组。`);
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          if (fileBuffer.reactiveItem) {
            fileBuffer.reactiveItem.url = url;
            fileBuffer.reactiveItem.progress = 100; // 确保最终进度为100
          }
          console.log(`[${mySessionId.value}] 文件 ${fileBuffer.metadata.fileName} 重组完成，可下载。`);
          delete incomingFileBuffers[fileId]; // 释放内存
        }
      }
    } catch (e) {
      console.error(`[${mySessionId.value}] 处理DataChannel消息出错 (来自 ${peerId}): ${e.message}`);
    }
  };
};

const concatenateArrayBuffers = (buffers) => {
  let totalLength = 0;
  // 确保处理稀疏数组，因为 DataChannel 可能会乱序发送
  const sortedBuffers = buffers.filter(Boolean).sort((a, b) => {
      // 这里的排序需要知道原始的 chunkIndex，但目前你的 `buffers` 只是 `chunks: []` 数组
      // DataChannel 默认可靠性会保证顺序，所以这里只需要连接非空的即可
      return 0; // 实际上，如果 DataChannel 是有序的，那么它们应该已经是正确的顺序
  });

  for (const buffer of sortedBuffers) {
    totalLength += buffer.byteLength;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of sortedBuffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return result.buffer;
};

const closePeerConnection = (peerId) => {
  if (peerConnections[peerId]) {
    console.log(`[${mySessionId.value}] 关闭与 ${peerId} 的 PeerConnection`);
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
    console.error(`无法发送信令消息给 ${toId}: WS 未打开或缺少目标 for ${type}`);
  }
};

const createOffer = async (targetPeerId) => {
  if (peerConnections[targetPeerId] && peerConnections[targetPeerId].pc &&
    peerConnections[targetPeerId].pc.localDescription && peerConnections[targetPeerId].pc.localDescription.type === 'offer') {
    console.log(`[${mySessionId.value}] 已有Offer for ${targetPeerId}，跳过创建。`);
    return;
  }

  const pc = createPeerConnection(targetPeerId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingMessage('offer', { sdp: offer }, targetPeerId);
    console.log(`[${mySessionId.value}] 已创建并发送Offer给 ${targetPeerId}`);
  } catch (error) {
    console.error(`[${mySessionId.value}] 创建Offer失败 for ${targetPeerId}: ${error.message}`);
  }
};

const handleOffer = async (sdp, fromId) => {
  const pc = createPeerConnection(fromId, false);
  try {
    console.log(`[${mySessionId.value}] 设置远程描述 (Offer) from ${fromId}`);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    console.log(`[${mySessionId.value}] 设置本地描述 (Answer) for ${fromId}`);
    await pc.setLocalDescription(answer);
    sendSignalingMessage('answer', { sdp: answer }, fromId);
    console.log(`[${mySessionId.value}] 已创建并发送Answer给 ${fromId}`);
  } catch (error) {
    console.error(`[${mySessionId.value}] 处理Offer失败 from ${fromId}: ${error.message}`);
  }
};

const handleAnswer = async (sdp, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer 但没有对应的 PeerConnection`);
    return;
  }
  try {
    if (pcInfo.pc.signalingState !== 'have-local-offer') {
      console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 Answer，但信令状态为 ${pcInfo.pc.signalingState}。期望 'have-local-offer'。`);
    }
    console.log(`[${mySessionId.value}] 设置远程描述 (Answer) from ${fromId}`);
    await pcInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (error) {
    console.error(`[${mySessionId.value}] 处理Answer失败 from ${fromId}: ${error.message}`);
  }
};

const handleCandidate = async (candidate, fromId) => {
  const pcInfo = peerConnections[fromId];
  if (!pcInfo || !pcInfo.pc) {
    console.warn(`[${mySessionId.value}] 收到来自 ${fromId} 的 ICE Candidate 但没有对应的 PeerConnection`);
    return;
  }
  try {
    console.log(`[${mySessionId.value}] 添加 ICE Candidate for ${fromId}`);
    await pcInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error(`[${mySessionId.value}] 添加 ICE Candidate 失败 for ${fromId}: ${error.message}`);
    // 如果是重复的或无效的候选者，可能会在这里报错，但通常不影响连接
  }
};

// --- File Selection & Broadcasting Logic ---
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendFileProgress.value = 0;
  fileTransferError.value = '';
};

// 重构发送函数，支持逐个 peer 发送并控制流量
const sendFileToPeer = async (targetPeerId, file) => {
  const pcInfo = peerConnections[targetPeerId];
  if (!pcInfo || !pcInfo.dc || pcInfo.dc.readyState !== 'open') {
    console.warn(`[${mySessionId.value}] 无法发送文件给 ${targetPeerId}，DataChannel 未打开或不存在。`);
    // 可以将此文件添加到队列，等待DataChannel打开
    // if (!pcInfo) peerConnections[targetPeerId] = { pc: null, dc: null, fileQueue: [] };
    // pcInfo.fileQueue.push({ file, id: `${mySessionId.value}-${Date.now()}-${file.name}`, offset: 0, isSending: false });
    return;
  }

  const dc = pcInfo.dc;
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

  try {
    dc.send(metadataPayload);
    console.log(`[${mySessionId.value}] 发送文件元数据给 ${targetPeerId} for ${fileId}`);
  } catch (e) {
    console.error(`[${mySessionId.value}] 无法通过 DataChannel 发送元数据给 ${targetPeerId}: ${e.message}`);
    fileTransferError.value = `无法发送文件元数据给 ${targetPeerId}: ${e.message}`;
    return;
  }

  const fileTransferState = {
    file: file,
    fileId: fileId,
    offset: 0,
    reader: new FileReader(),
    isSending: false, // 标记当前文件是否正在发送中
    targetPeerId: targetPeerId, // 记录目标 peerId
    // resolved when transfer is complete
    resolve: null,
    reject: null
  };

  // 将当前文件的传输状态添加到队列
  pcInfo.fileQueue.push(fileTransferState);

  // 如果DataChannel当前空闲，且没有其他文件在传输，则开始发送
  if (!fileTransferState.isSending && dc.bufferedAmount === 0 && pcInfo.fileQueue.length === 1) {
    console.log(`[${mySessionId.value}] 首次启动文件发送 for ${targetPeerId}`);
    fileTransferState.isSending = true;
    readNextChunk(fileTransferState);
  }

  return new Promise((resolve, reject) => {
    fileTransferState.resolve = resolve;
    fileTransferState.reject = reject;
  });
};

const sendFileBroadcast = async () => {
  const activePeerIds = Object.keys(peerConnections).filter(peerId =>
    peerConnections[peerId].dc && peerConnections[peerId].dc.readyState === 'open'
  );

  if (activePeerIds.length === 0) {
    fileTransferError.value = '没有活跃的 Data Channel 可用于广播。请等待对等端连接。';
    return;
  }
  if (!selectedFile.value) {
    fileTransferError.value = '未选择文件。';
    return;
  }

  fileTransferError.value = ''; // 清除之前的错误信息
  sendFileProgress.value = 0; // 重置全局进度条

  const fileToBroadcast = selectedFile.value;
  let totalBytesSent = 0;
  let completedTransfers = 0;

  const transferPromises = activePeerIds.map(peerId =>
    sendFileToPeer(peerId, fileToBroadcast)
  );

  Promise.all(transferPromises).then(() => {
    console.log('所有文件传输完成 (广播)。');
    // 如果是广播，全局进度条在每个 peer 都完成时才算完成
    sendFileProgress.value = 100;
    selectedFile.value = null;
    if (document.querySelector('input[type="file"]')) {
      document.querySelector('input[type="file"]').value = '';
    }
  }).catch(error => {
    console.error('广播文件传输中存在错误:', error);
    fileTransferError.value = '文件广播失败：' + error.message;
  });

  // 虽然现在是广播，但全局进度条的更新需要综合考虑
  // 更合理的做法是，每个peer有自己的进度条，或者将广播进度条改为“所有peer的最低进度”
  // 这里暂时保持只显示发送方的总体进度，但它会根据第一个完成的peer来更新
  // 一个简单的全局进度更新：
  // 每次发送chunk，我们更新一个全局的 `totalSentBytesAcrossAllPeers`
  // 然后 `sendFileProgress.value = (totalSentBytesAcrossAllPeers / (fileToBroadcast.size * activePeerIds.length)) * 100;`
  // 这会更复杂，目前暂时不实现，仅用发送方自身进度示意
};


const readNextChunk = (fileTransferState) => {
  const { file, offset, reader, fileId, targetPeerId } = fileTransferState;
  const slice = file.slice(offset, offset + CHUNK_SIZE);
  reader.readAsArrayBuffer(slice);

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
    header[headerOffset++] = isLastChunk ? 1 : 0; // 即使不用于判断，也保留

    const combinedBuffer = new Uint8Array(header.byteLength + chunk.byteLength);
    combinedBuffer.set(header, 0);
    combinedBuffer.set(new Uint8Array(chunk), header.byteLength);

    const pcInfo = peerConnections[targetPeerId];
    if (!pcInfo || !pcInfo.dc || pcInfo.dc.readyState !== 'open') {
        console.error(`[${mySessionId.value}] DataChannel for ${targetPeerId} 已关闭或不存在，停止发送。`);
        fileTransferState.reject(new Error(`DataChannel for ${targetPeerId} closed unexpectedly.`));
        return;
    }

    const dc = pcInfo.dc;

    // 发送 chunk
    try {
      dc.send(combinedBuffer.buffer);
      fileTransferState.offset += chunk.byteLength;
      sendFileProgress.value = (fileTransferState.offset / file.size) * 100; // 更新发送方进度条

      if (fileTransferState.offset < file.size) {
        // 如果 DataChannel 缓冲区未满，继续发送下一个块
        if (dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
          readNextChunk(fileTransferState);
        } else {
          // 缓冲区已满，等待 onbufferedamountlow 事件
          console.log(`[${mySessionId.value}] DataChannel 缓冲区已满 for ${targetPeerId}，等待...`);
          // 确保当 onbufferedamountlow 触发时，会继续发送
        }
      } else {
        // 文件发送完成
        const completeSignalPayload = JSON.stringify({
          type: 'file-transfer-complete-signal',
          fileId: fileId,
          fileName: file.name,
          from: mySessionId.value
        });
        dc.send(completeSignalPayload); // 发送完成信号
        console.log(`[${mySessionId.value}] 文件 ${file.name} (ID: ${fileId}) 发送完成给 ${targetPeerId}`);
        fileTransferState.isSending = false;
        // 从队列中移除已完成的文件
        pcInfo.fileQueue.shift();
        fileTransferState.resolve(); // 解决 Promise

        // 检查队列中是否有其他文件需要发送
        if (pcInfo.fileQueue.length > 0) {
            console.log(`[${mySessionId.value}] 队列中有其他文件，开始发送下一个。`);
            const nextFileTransfer = pcInfo.fileQueue[0];
            nextFileTransfer.isSending = true;
            readNextChunk(nextFileTransfer);
        }
      }
    } catch (e) {
      console.error(`[${mySessionId.value}] 通过 DataChannel 发送文件块失败给 ${targetPeerId}: ${e.message}`);
      fileTransferError.value = `文件发送失败给 ${targetPeerId}: ${e.message}`;
      fileTransferState.isSending = false;
      fileTransferState.reject(e); // 拒绝 Promise
      // 可以在这里选择停止整个传输或尝试重试
    }
  };

  reader.onerror = (error) => {
    console.error(`[${mySessionId.value}] FileReader 错误 for ${fileId}:`, error);
    fileTransferError.value = '读取文件出错: ' + error.message;
    fileTransferState.isSending = false;
    fileTransferState.reject(error);
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
  stopHeartbeat(); // 确保组件卸载时停止心跳
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