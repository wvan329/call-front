<template>
  <div class="voice-container">
    <div class="status-indicator" :class="{ active: isConnected }">
      {{ statusText }}
    </div>
    
    <div class="controls">
      <button class="control-button" @click="toggleMute">
        {{ isMuted ? '取消静音' : '静音' }}
      </button>
      <button class="control-button" @click="endCall">
        结束通话
      </button>
    </div>

    <!-- 播放多个远端音频流 -->
    <div v-for="(stream, id) in remoteStreams" :key="id">
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
const statusText = ref('正在连接服务器...');

const audioRefs = reactive({});

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
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && socket.value.readyState === WebSocket.OPEN) {
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

  peerConnections[remoteId] = pc;

  if (localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

  return pc;
}

function cleanupPeerConnections() {
  Object.values(peerConnections).forEach(pc => pc.close());
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
  } catch (e) {
    statusText.value = '麦克风权限拒绝';
    console.error('获取麦克风权限失败', e);
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

function endCall() {
  if (socket.value && socket.value.readyState === WebSocket.OPEN) {
    socket.value.close();
  }
  cleanupPeerConnections();
  if (localStream.value) {
    localStream.value.getTracks().forEach(t => t.stop());
    localStream.value = null;
  }
  statusText.value = '通话已结束';
  isConnected.value = false;
}

onMounted(async () => {
  await getLocalStream();

  socket.value = new WebSocket(`ws://${host}/wgk/ws`);

  socket.value.onopen = () => {
    statusText.value = '连接成功，加入通话...';
    socket.value.send(JSON.stringify({
      type: 'join',
      from: userId
    }));
  };

  socket.value.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };

  socket.value.onclose = () => {
    statusText.value = '连接已断开';
    cleanupPeerConnections();
  };
});

onBeforeUnmount(() => {
  endCall();
});
</script>


<style scoped>
.voice-container {
  position: relative;
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  font-family: 'Arial', sans-serif;
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
}

.status-indicator.active {
  background-color: #4CAF50;
}

.controls {
  display: flex;
  gap: 20px;
  margin-top: 20px;
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
    text-align: center;
  }
}
</style>
