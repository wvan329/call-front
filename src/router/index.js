// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router'
import TalkRoom from '@/views/TalkRoom.vue'
import File from '@/views/File.vue' // 你刚创建的那个组件

const routes = [
  { path: '/', redirect: '/call/talk' },
  { path: '/call/talk', component: TalkRoom },
  { path: '/call/file', component: File },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
