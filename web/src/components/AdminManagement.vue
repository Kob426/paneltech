<script setup lang="ts">
import type { AdminClub, AdminDevice } from '../admin';
import type { AdminServices } from '../composables/useAdminActions';
import ClubManagement from './ClubManagement.vue';
import StaffManagement from './StaffManagement.vue';

defineProps<{
  userId: string;
  clubs: AdminClub[];
  club?: AdminClub;
  devices: AdminDevice[];
  realAgents: boolean;
  services: AdminServices;
  busy: boolean;
  online: boolean;
}>();
</script>

<template>
  <div class="two-columns">
    <ClubManagement :clubs="clubs" :club="club" :devices="devices" :real-agents="realAgents" :services="services" :busy="busy" :online="online" />
    <StaffManagement :user-id="userId" :services="services" :busy="busy" :online="online" />
  </div>
</template>
