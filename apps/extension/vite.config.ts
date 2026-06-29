import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import webExtension from 'vite-plugin-web-extension';
import path from 'path';
import fs from 'fs';

function fixManifestExtensions(): Plugin {
  return {
    name: 'fix-manifest-extensions',
    closeBundle() {
      const manifestPath = path.resolve(__dirname, 'dist/manifest.json');
      if (!fs.existsSync(manifestPath)) return;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        background?: { service_worker?: string };
        content_scripts?: Array<{ js?: string[] }>;
      };
      if (manifest.background?.service_worker) {
        manifest.background.service_worker = manifest.background.service_worker.replace(
          /\.ts$/,
          '.js',
        );
      }
      if (manifest.content_scripts) {
        manifest.content_scripts = manifest.content_scripts.map((cs) => ({
          ...cs,
          js: cs.js?.map((j) => j.replace(/\.ts$/, '.js')),
        }));
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDev = mode === 'development';

  return {
    plugins: [
      react(),
      webExtension({
        manifest: './public/manifest.json',
        // offscreen, editor and permission are not in the manifest so they need their own entries
        additionalInputs: [
          'src/offscreen/index.html',
          'src/editor/index.html',
          'src/permission/index.html',
        ],
        disableAutoLaunch: true,
      }),
      fixManifestExtensions(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(
        env['VITE_API_BASE_URL'] || 'http://localhost:3000/api',
      ),
      'import.meta.env.VITE_RP_HOST': JSON.stringify(
        env['VITE_RP_HOST'] || 'http://localhost:3000',
      ),
      'import.meta.env.VITE_SSO_TOKEN_URL': JSON.stringify(
        env['VITE_SSO_TOKEN_URL'] ||
          `${env['VITE_RP_HOST'] || 'http://localhost:3000'}/uat/sso/oauth/token`,
      ),
      'import.meta.env.VITE_INSTANCE_LABEL': JSON.stringify(env['VITE_INSTANCE_LABEL'] || ''),
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    build: {
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
    },
    optimizeDeps: {
      exclude: ['fabric'],
    },
  };
});
