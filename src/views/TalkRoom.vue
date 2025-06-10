<template>
  <div>
    <button @mousedown="startSpeaking" @mouseup="stopSpeaking">按住说话</button>
    <audio v-for="(stream, id) in remoteStreams" :key="id" :ref="setAudioRef(id)" autoplay></audio>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue';

export default {
  setup() {
    const remoteStreams = ref({});
    const audioElements = ref({});
    const localStream = ref(null);
    const peers = ref({});
    const socket = ref(null);
    const host = window.location.host;
    const myId = ref(null);
    const room = 'default-room'; // 可扩展支持多个房间

    const setAudioRef = (id) => (el) => {
      if (el) audioElements.value[id] = el;
    };

    const cleanup = () => {
      Object.values(peers.value).forEach(pc => pc.close());
      peers.value = {};
      Object.values(remoteStreams.value).forEach(stream => {
        stream.getTracks().forEach(track => track.stop());
      });
      remoteStreams.value = {};
      if (localStream.value) {
        localStream.value.getTracks().forEach(track => track.stop());
        localStream.value = null;
      }
      if (socket.value) {
        socket.value.close();
        socket.value = null;
      }
    };

    const startSpeaking = async () => {
      if (!localStream.value) {
        localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
        Object.values(peers.value).forEach(pc => {
          localStream.value.getTracks().forEach(track => {
            pc.addTrack(track, localStream.value);
          });
        });
      }
    };

    const stopSpeaking = () => {
      if (localStream.value) {
        localStream.value.getTracks().forEach(track => track.stop());
        localStream.value = null;
      }
    };

    const initSocket = () => {
      socket.value = new WebSocket(`wss://${host}/wgk/ws`);
      socket.value.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'id') {
          myId.value = data.id;
        }

        if (data.type === 'user-list') {
          data.users.forEach(peerId => {
            if (peerId !== myId.value && !peers.value[peerId]) {
              createPeer(peerId, true);
            }
          });
        }

        if (data.type === 'offer' && data.to === myId.value) {
          await createPeer(data.from, false, data.offer);
        }

        if (data.type === 'answer' && data.to === myId.value) {
          await peers.value[data.from].setRemoteDescription(new RTCSessionDescription(data.answer));
        }

        if (data.type === 'ice-candidate' && data.to === myId.value) {
          try {
            await peers.value[data.from].addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.error('添加 ICE 失败', e);
          }
        }
      };
    };

    const createPeer = async (peerId, isInitiator, remoteOffer = null) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.value.send(JSON.stringify({
            type: 'ice-candidate',
            to: peerId,
            from: myId.value,
            candidate: e.candidate
          }));
        }
      };

      pc.ontrack = (e) => {
        if (!remoteStreams.value[peerId]) {
          remoteStreams.value[peerId] = e.streams[0];
        }
        if (audioElements.value[peerId]) {
          audioElements.value[peerId].srcObject = e.streams[0];
        }
      };

      // 添加本地轨道（如果已获取）
      if (localStream.value) {
        localStream.value.getTracks().forEach(track => {
          pc.addTrack(track, localStream.value);
        });
      }

      peers.value[peerId] = pc;

      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.value.send(JSON.stringify({
          type: 'offer',
          to: peerId,
          from: myId.value,
          offer
        }));
      } else if (remoteOffer) {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.value.send(JSON.stringify({
          type: 'answer',
          to: peerId,
          from: myId.value,
          answer
        }));
      }
    };

    onMounted(() => {
      cleanup();
      initSocket();
    });

    onUnmounted(() => {
      cleanup();
    });

    return {
      startSpeaking,
      stopSpeaking,
      remoteStreams,
      setAudioRef
    };
  }
};
</script>
