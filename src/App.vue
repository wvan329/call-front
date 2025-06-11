<template>
  <div>
    <nav>
      <router-link to="/talk" class="text-blue-600 hover:underline">🗨️ 聊天</router-link>
      <router-link to="/file" class="text-green-600 hover:underline">📁 文件传输</router-link>
    </nav>

    <router-view />
  </div>
</template>

<script setup>
// 无需额外代码，Vue Router 自动渲染
</script>

<style scoped>
nav a.router-link-exact-active {
  font-weight: bold;
  text-decoration: underline;
}
</style>
