<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import DocumentationHome from './components/DocumentationHome.vue'

const { Layout: DefaultLayout } = DefaultTheme
const { frontmatter } = useData()
</script>

<template>
  <DefaultLayout>
    <!--
      The documentation home is drawn here instead of from the page body: this
      site renders markdown with `html: false`, so a component tag written in a
      `.md` file is escaped into literal text. A page opts in by setting
      `qnHome` in its frontmatter, and the markdown body stays empty — the
      component supplies the page's single `<h1>`.
    -->
    <template #page-top>
      <DocumentationHome
        v-if="frontmatter.qnHome"
        :locale="frontmatter.qnHome === 'zh-CN' ? 'zh-CN' : 'en'"
      />
    </template>
  </DefaultLayout>
</template>
