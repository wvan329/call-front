<template>
  <div class="voice-container">
    <div class="status-indicator" :class="{ active: isConnected }">
      {{ statusText }}
    </div>
    
    <div class="controls">
      <button class="control-button" @click="toggleMute" :disabled="!isConnected">
        <i class="fa" :class="isMuted ? 'fa-microphone-slash' : 'fa-microphone'"></i>
        {{ isMuted ? '取消静音' : '静音' }}
      </button>
      <button class="control-button" @click="toggleCall">
        <i class="fa" :class="isConnected ? 'fa-phone' : 'fa-phone-square'"></i>
        {{ isConnected ? '结束通话' : '开始通话' }}
      </button>
    </div>

    <!-- 播放多个远端音频流 -->
    <div v-for="(stream, id) in remoteStreams" :key="id" class="remote-audio-container">
      <div class="user-info">
        <div class="user-avatar">
          <i class="fa fa-user"></i>
        </div>
        <div class="user-id">{{ id.substring(0, 5) }}</div>
      </div>
      <audio :ref="setAudioElement(id)" autoplay></audio>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue';

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

const host = window.location.host;
const socket = ref(null);
const localStream = ref(null);
const userId = generateId();

const peerConnections = reactive({});
const remoteStreams = reactive({});

const isConnected = ref(false);
const isMuted = ref(false);
const statusText = ref('正在连接...');

const audioRefs = reactive({});
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;

const setAudioElement = (id) => (el) => {
  if (el) {
    audioRefs[id] = el;
    if (remoteStreams[id]) {
      el.srcObject = remoteStreams[id];
    }
  }
};

function createPeerConnection(remoteId) {
  if (peerConnections[remoteId]) return peerConnections[remoteId];

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun.l.google.com' },
      { urls: 'stun:stun1.l.google.com' },
      { urls: 'stun:stun2.l.google.com' },
    ]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && socket.value && socket.value.readyState === WebSocket.OPEN) {
      socket.value.send(JSON.stringify({
        type: 'ice-candidate',
        from: userId,
        to: remoteId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    remoteStreams[remoteId] = event.streams[0];
    nextTick(() => {
      if (audioRefs[remoteId]) {
        audioRefs[remoteId].srcObject = event.streams[0];
      }
    });
    isConnected.value = true;
    statusText.value = '通话中...';
  };

  // 监控连接状态
  pc.onconnectionstatechange = () => {
    console.log(`PeerConnection(${remoteId}) state:`, pc.connectionState);
    
    if (pc.connectionState === 'failed') {
      statusText.value = `与 ${remoteId.substring(0, 5)} 的连接失败`;
      setTimeout(() => {
        if (peerConnections[remoteId]) {
          peerConnections[remoteId].close();
          delete peerConnections[remoteId];
          delete remoteStreams[remoteId];
        }
      }, 3000);
    } else if (pc.connectionState === 'disconnected') {
      statusText.value = `与 ${remoteId.substring(0, 5)} 的连接断开`;
    } else if (pc.connectionState === 'connected') {
      statusText.value = '通话中...';
    }
  };

  // 处理ICE候选者收集状态
  pc.onicegatheringstatechange = () => {
    console.log(`ICE gathering state for ${remoteId}:`, pc.iceGatheringState);
  };

  peerConnections[remoteId] = pc;

  if (localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

  return pc;
}

function cleanupPeerConnections() {
  Object.values(peerConnections).forEach(pc => {
    pc.close();
  });
  
  Object.values(remoteStreams).forEach(stream => {
    stream.getTracks().forEach(track => track.stop());
  });
  
  for (const key in peerConnections) {
    delete peerConnections[key];
  }
  for (const key in remoteStreams) {
    delete remoteStreams[key];
  }
  
  isConnected.value = false;
}

async function getLocalStream() {
  try {
    localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (e) {
    statusText.value = '麦克风权限拒绝';
    console.error('获取麦克风权限失败', e);
    return false;
  }
}

async function handleMessage(data) {
  if (data.from === userId) return;

  switch (data.type) {
    case 'join': {
      const pc = createPeerConnection(data.from);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.value.send(JSON.stringify({
          type: 'offer',
          from: userId,
          to: data.from,
          offer
        }));
      } catch (e) {
        console.error('创建offer失败', e);
        statusText.value = '连接失败，请重试';
      }
      break;
    }
    case 'offer': {
      const pc = createPeerConnection(data.from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.value.send(JSON.stringify({
          type: 'answer',
          from: userId,
          to: data.from,
          answer
        }));
      } catch (e) {
        console.error('处理offer失败', e);
        statusText.value = '连接失败，请重试';
      }
      break;
    }
    case 'answer': {
      const pc = peerConnections[data.from];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (e) {
        console.error('设置answer失败', e);
        statusText.value = '连接失败，请重试';
      }
      break;
    }
    case 'ice-candidate': {
      const pc = peerConnections[data.from];
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('添加ICE candidate失败', e);
      }
      break;
    }
  }
}

function toggleMute() {
  if (localStream.value) {
    localStream.value.getAudioTracks().forEach(track => {
      track.enabled = !track.enabled;
    });
    isMuted.value = !isMuted.value;
  }
}

function connectWebSocket() {
  socket.value = new WebSocket(`ws://${host}/wgk/ws`);

  socket.value.onopen = () => {
    statusText.value = '连接成功，加入通话...';
    reconnectAttempts = 0;
    clearInterval(reconnectTimer);
    
    // 重新加入房间
    socket.value.send(JSON.stringify({
      type: 'join',
      from: userId
    }));
  };

  socket.value.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleMessage(data);
    } catch (e) {
      console.error('解析消息失败', e);
    }
  };

  socket.value.onclose = () => {
    statusText.value = '连接已断开，尝试重连...';
    cleanupPeerConnections();
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.pow(2, reconnectAttempts) * 1000;
      reconnectAttempts++;
      reconnectTimer = setTimeout(connectWebSocket, delay);
    } else {
      statusText.value = '重连失败，请刷新页面';
    }
  };
  
  socket.value.onerror = (error) => {
    console.error('WebSocket error:', error);
    socket.value.close();
  };
}

async function startCall() {
  statusText.value = '正在连接...';
  
  const hasMicAccess = await getLocalStream();
  if (!hasMicAccess) {
    return;
  }
  
  connectWebSocket();
}

function endCall() {
  if (socket.value) {
    socket.value.close();
    socket.value = null;
  }
  cleanupPeerConnections();
  if (localStream.value) {
    localStream.value.getTracks().forEach(t => t.stop());
    localStream.value = null;
  }
  statusText.value = '点击开始通话';
  isMuted.value = false;
}

function toggleCall() {
  if (isConnected.value) {
    endCall();
  } else {
    startCall();
  }
}

onMounted(async () => {
  // 页面加载后立即开始通话
  await startCall();
});

onBeforeUnmount(() => {
  endCall();
  clearInterval(reconnectTimer);
});
</script>

<style scoped>
/* 保持原有样式不变 */
.voice-container {
  position: relative;
  width: 100%;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  font-family: 'Arial', sans-serif;
  padding: 20px;
  box-sizing: border-box;
}

.status-indicator {
  padding: 15px 30px;
  background-color: #6e8efb;
  color: white;
  border-radius: 50px;
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 30px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
  text-align: center;
}

.status-indicator.active {
  background-color: #4CAF50;
}

.controls {
  display: flex;
  gap: 20px;
  margin-top: 20px;
  flex-wrap: wrap;
  justify-content: center;
}

.control-button {
  padding: 12px 24px;
  background: linear-gradient(145deg, #6e8efb, #a777e3);
  border: none;
  color: white;
  font-size: 16px;
  font-weight: bold;
  border-radius: 50px;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 15px rgba(0, 0, 0, 0.15);
}

.control-button:active {
  transform: translateY(0);
}

.control-button:nth-child(2) {
  background: linear-gradient(145deg, #ff5e62, #ff9966);
}

.control-button:disabled {
  background: #cccccc;
  cursor: not-allowed;
}

.remote-audio-container {
  display: flex;
  align-items: center;
  gap: 15px;
  background-color: rgba(255, 255, 255, 0.8);
  border-radius: 15px;
  padding: 15px;
  margin: 10px 0;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
  width: 100%;
  max-width: 400px;
}

.user-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 60px;
}

.user-avatar {
  width: 40px;
  height: 40px;
  background-color: #6e8efb;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 18px;
  margin-bottom: 5px;
}

.user-id {
  font-size: 12px;
  color: #666;
  text-align: center;
}

audio {
  width: 100%;
  max-width: 300px;
}

@media (max-width: 768px) {
  .status-indicator {
    font-size: 16px;
    padding: 12px 24px;
  }
  
  .controls {
    flex-direction: column;
    gap: 15px;
  }
  
  .control-button {
    width: 200px;
    justify-content: center;
  }
  
  .remote-audio-container {
    flex-direction: column;
    text-align: center;
  }
}
</style>    