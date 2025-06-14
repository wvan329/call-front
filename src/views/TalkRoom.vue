<template>
  <div class="chat-container">

    <div class="header">
      <h1>神秘组织</h1>
      <p>已连接: {{ Object.keys(peers).length + 1 }} 人</p>
    </div>
    <div class="participants">
      <div class="participant">
        <div class="avatar-wrapper" :class="{ 'is-speaking': isSpeaking }">
          <img src="https://i.pravatar.cc/150?u=local" alt="Local User" class="avatar">
        </div>
        <p class="name">你</p>
      </div>
      <div v-for="(peer, peerId) in peers" :key="peerId" class="participant">
        <div class="avatar-wrapper">
          <img :src="`https://i.pravatar.cc/150?u=${peerId}`" alt="Remote User" class="avatar">
        </div>
        <p class="name">用户 {{ peerId.slice(0, 4) }}</p>
        <audio :ref="el => { if (el) peer.audioEl = el }" autoplay></audio>
      </div>
    </div>
    <div class="controls">
      <button @click="toggleMute" class="control-btn" :class="{ 'is-muted': isMuted }">
        <svg v-if="!isMuted" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="22"></line>
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="1" y1="1" x2="23" y2="23"></line>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v-2a7 7 0 0 0-1.23-3.95"></path>
          <line x1="12" y1="19" x2="12" y2="22"></line>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

// --- 配置 ---
const WEBSOCKET_URL = 'ws://59.110.35.198/call-api/ws/voice';
const MAX_RECONNECT_ATTEMPTS = 10;

// --- 响应式状态 ---
const localStream = ref(null);
const peers = ref({});
const ws = ref(null);
const isMuted = ref(false);
const isSpeaking = ref(false);
const heartbeatIntervalId = ref(null); // 用于存放我们的心跳定时器ID

// --- 重连相关状态 ---
const isDisconnected = ref(false);
const reconnectAttempts = ref(0);
const reconnectTimerId = ref(null);
let isUnmounted = false; // 使用普通变量，因为它不需要是响应式的

let audioContext, analyser, microphone, javascriptNode;

// --- WebRTC 配置 ---
const pc_config = {
  iceServers: [
    { urls: 'stun:59.110.35.198:3478' }
  ]
};

// --- WebSocket 核心功能 ---
const connectWebSocket = () => {
  if (reconnectAttempts.value >= MAX_RECONNECT_ATTEMPTS) {
    console.error("已达到最大重连次数，停止重连。");
    return;
  }

  ws.value = new WebSocket(WEBSOCKET_URL);

  ws.value.onopen = () => {
    startHeartbeat(); // <--- 在连接成功后启动心跳

    console.log("WebSocket 连接成功!");
    isDisconnected.value = false;
    reconnectAttempts.value = 0; // 重置重连计数器
    clearTimeout(reconnectTimerId.value); // 清除可能存在的定时器
    // 如果 localStream 不存在，则初始化。否则直接加入房间。
    if (!localStream.value) {
      initLocalMedia();
    } else {
      sendMessage({ type: 'user-joined' });
    }
  };

  ws.value.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    const fromId = message.from;

    // 获取当前 PeerConnection（如果存在）
    const peer = peers.value[fromId];

    // 增加日志，方便调试所有收到的消息
    console.log(`收到消息: type=${message.type}, from=${fromId}, state=${peer?.pc?.signalingState || 'N/A'}`);

    if (message.type === 'offer') {
      // --- 这是关键的修复点 ---
      // 如果已存在一个 peer connection 并且其状态不是 'stable'，
      // 说明我们已经发起了 offer，正在等待 answer。
      // 此时我们应该忽略对方发来的 offer，以避免冲突。
      if (peer && peer.pc.signalingState !== 'stable') {
        console.warn(`[冲突处理] 收到来自 ${fromId} 的 offer，但当前信令状态为 ${peer.pc.signalingState}，忽略此 offer。`);
        return; // 礼貌地忽略这个 offer
      }

      const newPeer = peer || createPeerConnection(fromId);
      await newPeer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      const answer = await newPeer.pc.createAnswer();
      await newPeer.pc.setLocalDescription(answer);
      sendMessage({ type: 'answer', sdp: newPeer.pc.localDescription, to: fromId });

    } else if (message.type === 'answer') {
      if (peer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      } else {
        console.warn(`收到来自 ${fromId} 的 answer，但找不到对应的 Peer Connection。`);
      }

    } else if (message.type === 'candidate') {
      if (peer) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) {
          console.error('添加 ICE Candidate 失败:', e);
        }
      } else {
        console.warn(`收到来自 ${fromId} 的 candidate，但找不到对应的 Peer Connection。`);
      }

    } else if (message.type === 'user-joined') {
      console.log(`用户 ${fromId} 加入了房间，发起 offer。`);
      const newPeer = createPeerConnection(fromId);
      const offer = await newPeer.pc.createOffer();
      await newPeer.pc.setLocalDescription(offer);
      sendMessage({ type: 'offer', sdp: newPeer.pc.localDescription, to: fromId });

    } else if (message.type === 'user-left') {
      console.log(`用户 ${fromId} 离开了房间。`);
      if (peer) {
        peer.pc.close();
        delete peers.value[fromId];
      }
    }
  };

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

  const stopHeartbeat = () => {
    console.log('停止心跳机制...');
    if (heartbeatIntervalId.value) {
      clearInterval(heartbeatIntervalId.value);
      heartbeatIntervalId.value = null;
    }
  };

  ws.value.onclose = () => {
    stopHeartbeat(); // <--- 在连接关闭时停止心跳
    if (isUnmounted) {
      console.log("组件已卸载，WebSocket 正常关闭。");
      return;
    }
    console.log("WebSocket 连接关闭，准备重连...");
    handleDisconnection();
  };

  ws.value.onerror = (error) => {
    console.error("WebSocket 错误:", error);
    // 错误事件通常会紧随着关闭事件，所以主要逻辑放在 onclose 中处理
  };
};

const sendMessage = (message) => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify(message));
  } else {
    console.error("无法发送消息，WebSocket 未连接。");
  }
};

// --- 重连处理 ---
const handleDisconnection = () => {
  // 清理所有旧的 Peer Connections，因为它们依赖于旧的 WebSocket 会话
  cleanupPeers();

  if (!isDisconnected.value) {
    isDisconnected.value = true;
  }
  reconnectAttempts.value++;
  // 指数退避算法
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts.value)); // 最长等待30秒
  console.log(`第 ${reconnectAttempts.value} 次重连将在 ${delay / 1000} 秒后开始...`);

  reconnectTimerId.value = setTimeout(connectWebSocket, delay);
};

// --- WebRTC 核心功能 ---
const initLocalMedia = async () => {
  try {
    localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setupSpeechDetection();
    sendMessage({ type: 'user-joined' });
  } catch (error) {
    console.error("获取麦克风权限失败:", error);
    alert("无法获取麦克风权限，语音聊天功能无法使用。");
  }
};

const createPeerConnection = (peerId) => {
  const pc = new RTCPeerConnection(pc_config);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({ type: 'candidate', candidate: event.candidate, to: peerId });
    }
  };

  pc.ontrack = (event) => {
    if (peers.value[peerId] && event.streams && event.streams[0]) {
      peers.value[peerId].audioEl.srcObject = event.streams[0];
    }
  };

  if (localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

  // 新增：监控单个 peer 的连接状态
  pc.oniceconnectionstatechange = () => {
    console.log(`Peer ${peerId} ICE connection state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
      // 如果单个 peer 断开，可以尝试在这里处理它，或者依赖 WebSocket 的全局重连
      // 为简化，我们主要依赖 WebSocket 的重连
    }
  };

  peers.value[peerId] = { pc, audioEl: null };
  return peers.value[peerId];
};

// --- 清理和控制 ---
const cleanupPeers = () => {
  console.log("正在清理所有 Peer Connections...");
  Object.values(peers.value).forEach(peer => {
    if (peer.pc) {
      peer.pc.close();
    }
  });
  peers.value = {};
};

const toggleMute = () => {
  if (!localStream.value) return;
  localStream.value.getAudioTracks().forEach(track => {
    track.enabled = !track.enabled;
    isMuted.value = !track.enabled;
  });
};

const setupSpeechDetection = () => {
  // setupSpeechDetection 逻辑与之前版本相同
  if (!localStream.value || !localStream.value.getAudioTracks().length) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  microphone = audioContext.createMediaStreamSource(localStream.value);
  javascriptNode = audioContext.createScriptProcessor(512, 1, 1);
  analyser.smoothingTimeConstant = 0.7;
  analyser.fftSize = 2048;
  microphone.connect(analyser);
  analyser.connect(javascriptNode);
  javascriptNode.connect(audioContext.destination);
  javascriptNode.onaudioprocess = () => {
    const array = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(array);
    let values = 0;
    const length = array.length;
    for (let i = 0; i < length; i++) {
      values += (array[i]);
    }
    const average = values / length;
    isSpeaking.value = average > 15;
  };
};


// --- Vue 生命周期钩子 ---
onMounted(() => {
  isUnmounted = false;
  connectWebSocket();
});

onUnmounted(() => {
  isUnmounted = true;
  console.log("组件正在卸载，开始清理资源...");
  // 清理重连定时器
  if (reconnectTimerId.value) {
    clearTimeout(reconnectTimerId.value);
  }

  // 正常关闭 WebSocket 连接
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    // 主动离开，可以发一个离开消息
    // sendMessage({ type: 'user-left' }); // 这取决于你的服务器实现
    ws.value.close();
  }

  // 清理所有 WebRTC 连接
  cleanupPeers();

  // 停止本地媒体流
  if (localStream.value) {
    localStream.value.getTracks().forEach(track => track.stop());
  }

  // 清理语音检测
  if (javascriptNode) javascriptNode.onaudioprocess = null;
  if (audioContext) audioContext.close();
});
</script>

<style scoped>
/* 之前的样式保持不变 */
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap');

.chat-container {
  position: relative;
  /* 为遮罩层定位 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  height: 100vh;
  width: 100%;
  background-color: #121212;
  color: #e0e0e0;
  font-family: 'Poppins', sans-serif;
  padding: 2rem;
  box-sizing: border-box;
}

.header {
  text-align: center;
  margin-bottom: 2rem;
}

.header h1 {
  font-size: 2.5rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: #ffffff;
}

.header p {
  font-size: 1rem;
  color: #a0a0a0;
}

.participants {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  gap: 2rem;
  flex-grow: 1;
  width: 100%;
  max-width: 1200px;
}

.participant {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.avatar-wrapper {
  position: relative;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  padding: 6px;
  background: #333;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
  transition: all 0.3s ease;
}

.avatar-wrapper::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 50%;
  border: 3px solid transparent;
  transition: border-color 0.3s ease;
}

.avatar-wrapper.is-speaking::before {
  border-color: #4CAF50;
  animation: pulse 1.5s infinite;
}

.avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.name {
  margin-top: 1rem;
  font-weight: 600;
  color: #fafafa;
}

.controls {
  padding: 1.5rem 0;
}

.control-btn {
  background-color: #282828;
  border: none;
  border-radius: 50%;
  width: 64px;
  height: 64px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: background-color 0.2s ease;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}

.control-btn:hover {
  background-color: #383838;
}

.control-btn.is-muted {
  background-color: #e74c3c;
}

.control-btn.is-muted:hover {
  background-color: #c0392b;
}

.control-btn svg {
  color: #ffffff;
}

/* 新增样式 */
.reconnect-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.85);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  color: #fff;
  text-align: center;
}

.reconnect-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.reconnect-content h2 {
  font-size: 2rem;
  margin: 0;
}

.reconnect-content p {
  font-size: 1.1rem;
  color: #ccc;
  margin: 0;
}

.spinner {
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top: 4px solid #fff;
  width: 50px;
  height: 50px;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7);
  }

  70% {
    box-shadow: 0 0 0 10px rgba(76, 175, 80, 0);
  }

  100% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0);
  }
}
</style>