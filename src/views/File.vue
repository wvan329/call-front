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

// Store PeerConnection and DataChannel info for each peer
const peerConnections = reactive({});

const selectedFile = ref(null);
const sendFileProgress = ref(0); // Global progress for the sending file
const fileTransferError = ref('');

const receivedFiles = reactive([]); // List of received files for display

// Store buffers for incoming files, indexed by fileId
const incomingFileBuffers = {};

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
const CHUNK_SIZE = 16 * 1024; // 16KB per chunk
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB, increased for better throughput, adjust as needed

// Your WebSocket signaling server URL
const wsUrl = 'ws://59.110.35.198/wgk/ws/file';

// --- Utility Functions ---
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

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

const setupDataChannelListeners = (channel, peerId) => {
  channel.onopen = () => {
    console.log(`[${mySessionId.value}] DataChannel to ${peerId} 打开！ (readyState: ${channel.readyState})`);
    fileTransferError.value = ''; // Clear any previous error
    const pcInfo = peerConnections[peerId];
    if (pcInfo && pcInfo.fileQueue.length > 0) {
      const currentFileTransfer = pcInfo.fileQueue[0];
      // Only start if not already sending and buffer is empty
      if (!currentFileTransfer.isSending && channel.bufferedAmount === 0) {
        console.log(`[${mySessionId.value}] DataChannel for ${peerId} opened, starting queued file ${currentFileTransfer.fileId}.`);
        currentFileTransfer.isSending = true;
        // Make sure metadata is sent if it wasn't already (e.g., if DC wasn't open when sendFileToPeer was called)
        const metadata = {
          type: 'file-metadata-signal',
          fileId: currentFileTransfer.fileId,
          fileName: currentFileTransfer.file.name,
          fileType: currentFileTransfer.file.type || 'application/octet-stream',
          fileSize: currentFileTransfer.file.size,
          from: mySessionId.value
        };
        channel.send(JSON.stringify(metadata));
        console.log(`[${mySessionId.value}] Sent queued metadata for ${currentFileTransfer.fileId} to ${peerId}.`);
        readNextChunk(currentFileTransfer);
      } else {
        console.log(`[${mySessionId.value}] DataChannel for ${peerId} opened, but queue is already processing or buffer not empty.`);
      }
    }
  };

  channel.onclose = () => {
    console.log(`[${mySessionId.value}] DataChannel to ${peerId} 关闭。`);
    if (peerConnections[peerId]) {
      peerConnections[peerId].dc = null;
    }
  };

  channel.onerror = (error) => {
    console.error(`[${mySessionId.value}] DataChannel to ${peerId} 错误: ${error.message || error}`);
  };

  channel.onbufferedamountlow = () => {
    const pcInfo = peerConnections[peerId];
    if (pcInfo && pcInfo.fileQueue.length > 0) {
      const currentFileTransfer = pcInfo.fileQueue[0];
      // Continue sending if this file is actively sending and more chunks are needed
      if (currentFileTransfer.isSending && currentFileTransfer.offset < currentFileTransfer.file.size) {
        console.log(`[${mySessionId.value}] DataChannel bufferedAmountLow for ${peerId}, continuing transfer for ${currentFileTransfer.fileId}. Buffered amount: ${channel.bufferedAmount}`);
        readNextChunk(currentFileTransfer);
      } else if (channel.bufferedAmount === 0 && !currentFileTransfer.isSending && currentFileTransfer.offset === 0) {
          // Edge case: DC opened with file in queue, and bufferedAmount is low/zero, but isSending was never true
          console.log(`[${mySessionId.value}] DataChannel bufferedAmountLow, starting *new* queued transfer for ${currentFileTransfer.fileId} to ${peerId}.`);
          currentFileTransfer.isSending = true;
          // Ensure metadata is sent here too if it wasn't already
          const metadata = {
            type: 'file-metadata-signal',
            fileId: currentFileTransfer.fileId,
            fileName: currentFileTransfer.file.name,
            fileType: currentFileTransfer.file.type || 'application/octet-stream',
            fileSize: currentFileTransfer.file.size,
            from: mySessionId.value
          };
          channel.send(JSON.stringify(metadata));
          console.log(`[${mySessionId.value}] Sent queued metadata (onbufferedamountlow) for ${currentFileTransfer.fileId} to ${peerId}.`);
          readNextChunk(currentFileTransfer);
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
          console.log(`[${mySessionId.value}] 收到文件元数据 for ${fileId}: ${fileName} (${formatBytes(fileSize)}) 来自 ${from}`);
          if (incomingFileBuffers[fileId]) {
              console.warn(`[${mySessionId.value}] 收到重复的文件元数据 for ${fileId}.`);
              return;
          }

          const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
          const newFileItem = reactive({
            metadata: { fileName, fileType, fileSize },
            url: null,
            progress: 0,
            receivedSize: 0, // Track received size for this file
            index: receivedFiles.length // For array indexing if needed
          });
          receivedFiles.push(newFileItem);

          incomingFileBuffers[fileId] = {
            metadata: { fileName, fileType, fileSize },
            chunks: new Array(totalChunks).fill(null), // Pre-allocate array with nulls
            receivedSize: 0,
            from: from,
            progress: 0,
            index: receivedFiles.length - 1, // Point to the reactive item's index
            receivedChunkIndices: new Set(),
            totalChunks: totalChunks,
            reactiveItem: newFileItem // Reference to the reactive object in receivedFiles
          };

        } else if (parsedData.type === 'file-transfer-complete-signal') {
          console.log(`[${mySessionId.value}] 收到文件传输完成信号 for ${parsedData.fileId}.`);
          const fileBuffer = incomingFileBuffers[parsedData.fileId];
          if (fileBuffer) {
            // Final check on received size and chunk count
            if (fileBuffer.receivedSize === fileBuffer.metadata.fileSize && fileBuffer.receivedChunkIndices.size === fileBuffer.totalChunks) {
                console.log(`[${mySessionId.value}] 文件 ${fileBuffer.metadata.fileName} 成功接收并重组。`);
                // If not already done by last chunk
                if (!fileBuffer.reactiveItem.url) {
                    const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
                    const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
                    const url = URL.createObjectURL(blob);
                    fileBuffer.reactiveItem.url = url;
                    fileBuffer.reactiveItem.progress = 100;
                    console.log(`[${mySessionId.value}] File ${fileBuffer.metadata.fileName} final Blob created.`);
                }
            } else {
                console.warn(`[${mySessionId.value}] 文件 ${fileBuffer.metadata.fileName} 收到完成信号，但大小不匹配或有缺失块。`);
                fileTransferError.value = `文件 ${fileBuffer.metadata.fileName} 接收不完整。`;
                // Optionally clean up here or keep for manual retry/inspection
            }
            // Always delete the buffer to free memory after processing completion signal
            delete incomingFileBuffers[parsedData.fileId];
          } else {
              console.warn(`[${mySessionId.value}] 收到未知文件ID的完成信号: ${parsedData.fileId}.`);
          }
        } else {
          console.warn(`[${mySessionId.value}] DataChannel String (未知类型) from ${peerId}: ${receivedData}`);
        }
      } else if (receivedData instanceof ArrayBuffer) {
        // Data is a file chunk
        const view = new DataView(receivedData);
        const fileIdLen = view.getUint8(0);
        const fileId = new TextDecoder().decode(receivedData.slice(1, 1 + fileIdLen));
        const chunkIndex = view.getUint32(1 + fileIdLen, true); // true for little-endian
        const isLastChunkFlag = view.getUint8(1 + fileIdLen + 4); // For reference, not primary check
        const chunkData = receivedData.slice(1 + fileIdLen + 4 + 1);

        if (!incomingFileBuffers[fileId]) {
          console.error(`[${mySessionId.value}] 收到未知文件ID的块: ${fileId} (chunkIndex: ${chunkIndex}). 元数据可能丢失或顺序错误。`);
          return;
        }

        const fileBuffer = incomingFileBuffers[fileId];

        if (fileBuffer.receivedChunkIndices.has(chunkIndex)) {
            // console.warn(`[${mySessionId.value}] 收到重复的块 for fileId ${fileId}, chunkIndex ${chunkIndex}.`);
            return; // Ignore duplicate chunks
        }

        fileBuffer.chunks[chunkIndex] = chunkData;
        fileBuffer.receivedSize += chunkData.byteLength;
        fileBuffer.receivedChunkIndices.add(chunkIndex);

        // Update reactive progress for the specific file
        if (fileBuffer.reactiveItem) {
          fileBuffer.reactiveItem.receivedSize = fileBuffer.receivedSize; // Update for UI tracking
          fileBuffer.reactiveItem.progress = (fileBuffer.receivedSize / fileBuffer.metadata.fileSize) * 100;
          // console.log(`[${mySessionId.value}] File ${fileBuffer.metadata.fileName} progress: ${fileBuffer.reactiveItem.progress.toFixed(2)}%`);
        }

        // Only try to reassemble if all expected chunks are received AND total size matches
        if (fileBuffer.receivedSize === fileBuffer.metadata.fileSize && fileBuffer.receivedChunkIndices.size === fileBuffer.totalChunks) {
          console.log(`[${mySessionId.value}] 所有块已接收 for ${fileId}，开始重组文件。`);
          const fullBuffer = concatenateArrayBuffers(fileBuffer.chunks);
          const blob = new Blob([fullBuffer], { type: fileBuffer.metadata.fileType });
          const url = URL.createObjectURL(blob);

          if (fileBuffer.reactiveItem) {
            fileBuffer.reactiveItem.url = url;
            fileBuffer.reactiveItem.progress = 100; // Ensure final progress is 100
          }
          console.log(`[${mySessionId.value}] 文件 ${fileBuffer.metadata.fileName} 重组完成，可下载。`);
          // It's crucial to delete the buffer ONLY after the Blob is created AND URL is set
          // We will delete it when `file-transfer-complete-signal` is received
          // For now, keep it for final check if complete signal is lost or delayed
        }
      }
    } catch (e) {
      console.error(`[${mySessionId.value}] 处理DataChannel消息出错 (来自 ${peerId}): ${e.message}`, e);
      fileTransferError.value = `接收文件错误: ${e.message}`;
    }
  };
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

const sendFileBroadcast = async () => {
  console.log(`[${mySessionId.value}] sendFileBroadcast called.`);
  console.log(`[${mySessionId.value}] selectedFile.value:`, selectedFile.value);

  const activePeerIds = Object.keys(peerConnections).filter(peerId =>
    peerConnections[peerId].dc && peerConnections[peerId].dc.readyState === 'open'
  );

  console.log(`[${mySessionId.value}] 活跃 DataChannels (${activePeerIds.length}个):`, activePeerIds);

  if (activePeerIds.length === 0) {
    fileTransferError.value = '没有活跃的 Data Channel 可用于广播。请等待对等端连接。';
    console.error(`[${mySessionId.value}] No active DataChannels to broadcast.`);
    return;
  }
  if (!selectedFile.value) {
    fileTransferError.value = '未选择文件。';
    console.error(`[${mySessionId.value}] No file selected.`);
    return;
  }

  fileTransferError.value = ''; // Clear previous error
  sendFileProgress.value = 0; // Reset global progress

  const fileToBroadcast = selectedFile.value;
  const transferPromises = activePeerIds.map(peerId =>
    sendFileToPeer(peerId, fileToBroadcast)
  );

  // Monitor all transfers to update a consolidated progress or handle overall completion/failure
  Promise.all(transferPromises).then(() => {
    console.log(`[${mySessionId.value}] 所有文件传输完成 (广播)。`);
    sendFileProgress.value = 100;
    // Clear selected file after all transfers are theoretically complete
    selectedFile.value = null;
    if (document.querySelector('input[type="file"]')) {
      document.querySelector('input[type="file"]').value = '';
    }
  }).catch(error => {
    console.error(`[${mySessionId.value}] 广播文件传输中存在错误:`, error);
    fileTransferError.value = `文件广播失败：${error.message}`;
  });

  // A more complex global progress update would involve tracking bytes sent across all peers,
  // but for simplicity, we keep the single `sendFileProgress` updated by the currently sending chunk.
};

const sendFileToPeer = async (targetPeerId, file) => {
  const pcInfo = peerConnections[targetPeerId];
  if (!pcInfo) {
    console.warn(`[${mySessionId.value}] No pcInfo for ${targetPeerId}. Peer connection might not be established.`);
    return Promise.reject(new Error(`No peer connection info for ${targetPeerId}`));
  }

  // Ensure fileQueue is always initialized for each peer
  if (!pcInfo.fileQueue) {
      pcInfo.fileQueue = [];
  }

  const fileId = `${mySessionId.value}-${Date.now()}-${file.name}`;
  const fileTransferState = {
    file: file,
    fileId: fileId,
    offset: 0,
    reader: new FileReader(),
    isSending: false, // Flag to indicate if this specific transfer is actively sending chunks
    targetPeerId: targetPeerId,
    resolve: null,
    reject: null
  };

  // Add the new file transfer to the queue
  pcInfo.fileQueue.push(fileTransferState);
  console.log(`[${mySessionId.value}] 文件 ${file.name} (ID: ${fileId}) 添加到队列 for ${targetPeerId}. 当前队列长度: ${pcInfo.fileQueue.length}`);

  // Send metadata immediately if DataChannel is open
  const dc = pcInfo.dc;
  if (dc && dc.readyState === 'open') {
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
      console.log(`[${mySessionId.value}] 发送元数据 for ${fileId} 给 ${targetPeerId}.`);
    } catch (e) {
      console.error(`[${mySessionId.value}] 无法通过 DataChannel 发送元数据 for ${fileId} 给 ${targetPeerId}: ${e.message}`);
      fileTransferError.value = `无法发送元数据给 ${targetPeerId}: ${e.message}`;
      // Remove from queue and reject if metadata fails
      pcInfo.fileQueue = pcInfo.fileQueue.filter(f => f.fileId !== fileId);
      return Promise.reject(e);
    }

    // If this is the *first* file in the queue, and DC is open, start sending chunks
    if (pcInfo.fileQueue[0] === fileTransferState && dc.bufferedAmount === 0) {
      console.log(`[${mySessionId.value}] 为 ${fileId} 启动初始块传输给 ${targetPeerId}.`);
      fileTransferState.isSending = true; // Mark as actively sending
      readNextChunk(fileTransferState);
    }
  } else {
    console.warn(`[${mySessionId.value}] DataChannel to ${targetPeerId} 未打开或未准备好。元数据将等待DC打开后发送，块将排队等待。`);
  }

  return new Promise((resolve, reject) => {
    fileTransferState.resolve = resolve;
    fileTransferState.reject = reject;
  });
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