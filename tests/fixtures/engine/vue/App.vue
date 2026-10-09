<script setup lang="ts">
import Card from './Card.vue';
</script>

<template>
  <Card title="Engine" />
  <Card :title="42" />
</template>
