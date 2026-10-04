<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ locale: string }>()
const shotSrc = computed(() => `/readme/hero.${props.locale === 'zh-CN' ? 'zh' : 'en'}.webp`)
</script>

<template>
  <div class="hero-visual" aria-hidden="false">
    <div class="hero-visual__glow"></div>
    <img
      class="hero-visual__shot"
      :src="shotSrc"
      alt="QianNing Agent workspace"
      width="1600"
      height="1067"
      decoding="async"
      fetchpriority="high"
    />
  </div>
</template>
