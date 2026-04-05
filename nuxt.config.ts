export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Growbox Control',
      meta: [
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1, viewport-fit=cover',
        },
      ],
    },
  },
  nitro: {
    prerender: {
      routes: ['/'],
    },
  },
  runtimeConfig: {
    backendBase: process.env.NUXT_BACKEND_BASE ?? '/backend',
    public: {
      backendBase: process.env.NUXT_PUBLIC_BACKEND_BASE ?? '/backend',
    },
  },
});
