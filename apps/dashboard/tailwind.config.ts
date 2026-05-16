import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        jam: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        },
        gray: {
          850: '#1a1f2e',
          925: '#0d1117',
          950: '#0a0d14',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'spin-slow': 'spin 3s linear infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        glow: 'glow 2s ease-in-out infinite alternate',
        shimmer: 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        glow: {
          '0%': { boxShadow: '0 0 5px rgb(139 92 246 / 0.5)' },
          '100%': { boxShadow: '0 0 20px rgb(139 92 246 / 0.8), 0 0 40px rgb(139 92 246 / 0.3)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      backgroundImage: {
        glass: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
        'jam-gradient': 'linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)',
        'dark-gradient': 'linear-gradient(180deg, #0a0d14 0%, #0d1117 100%)',
        'card-gradient':
          'linear-gradient(135deg, rgba(124,58,237,0.1) 0%, rgba(76,29,149,0.05) 100%)',
        'shimmer-gradient':
          'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.05) 50%, transparent 100%)',
      },
      boxShadow: {
        glass:
          '0 4px 6px -1px rgba(0,0,0,0.4), 0 2px 4px -1px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)',
        'glow-sm': '0 0 10px rgba(139,92,246,0.3)',
        'glow-md': '0 0 20px rgba(139,92,246,0.4)',
        'glow-lg': '0 0 40px rgba(139,92,246,0.5)',
        card: '0 1px 3px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.4)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.4)',
      },
      borderColor: {
        glass: 'rgba(255,255,255,0.08)',
      },
    },
  },
  plugins: [],
};

export default config;
