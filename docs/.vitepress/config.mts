import { defineConfig } from 'vitepress';
export default defineConfig({
  title: 'Botroost', description: '机器人协议端的部署、管理与运行维护', lang: 'zh-CN', cleanUrls: true,
  srcDir: './site', outDir: './.vitepress/dist',
  sitemap: { hostname: 'https://botroost.idoknow.top' },
  themeConfig: {
    nav: [{ text: '开始', link: '/guide/' }, { text: '部署', link: '/deploy/' }, { text: '开发', link: '/development/' }],
    sidebar: [
      { text: '使用', items: [{ text: '项目介绍', link: '/guide/' }, { text: '节点与协议端', link: '/guide/endpoints' }] },
      { text: '部署', items: [{ text: '部署总览', link: '/deploy/' }, { text: 'Docker Compose', link: '/deploy/docker' }, { text: 'Linux systemd', link: '/deploy/systemd' }, { text: 'Kubernetes', link: '/deploy/kubernetes' }] },
      { text: '维护', items: [{ text: '升级与备份', link: '/operations/' }, { text: '故障排查', link: '/operations/troubleshooting' }] },
      { text: '开发', items: [{ text: '本地开发', link: '/development/' }, { text: '运行层与协议适配', link: '/development/architecture' }] },
    ],
    search: { provider: 'local' }, socialLinks: [{ icon: 'github', link: 'https://github.com/idoknow/botroost' }],
    footer: { message: 'Botroost 项目文档' },
  },
});
