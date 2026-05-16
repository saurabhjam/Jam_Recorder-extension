import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        jam: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
        dark: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
        '88': '22rem',
        '100': '25rem',
        '112': '28rem',
        '128': '32rem',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      animation: {
        'recording-pulse': 'recordingPulse 1.5s ease-in-out infinite',
        'upload-spin': 'uploadSpin 1s linear infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
      },
      keyframes: {
        recordingPulse: {
          '0%, 100%': {
            opacity: '1',
            transform: 'scale(1)',
          },
          '50%': {
            opacity: '0.5',
            transform: 'scale(1.2)',
          },
        },
        uploadSpin: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.9)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        glowPulse: {
          '0%, 100%': {
            boxShadow: '0 0 10px rgba(99, 102, 241, 0.4)',
          },
          '50%': {
            boxShadow: '0 0 30px rgba(99, 102, 241, 0.8)',
          },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      backgroundImage: {
        'jam-gradient': 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
        'jam-gradient-dark': 'linear-gradient(135deg, #4338ca 0%, #7c3aed 100%)',
        'glass-gradient':
          'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
        'recording-gradient': 'linear-gradient(90deg, #ef4444, #f97316)',
        shimmer:
          'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)',
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.1)',
        'glass-lg': '0 16px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.1)',
        jam: '0 4px 24px rgba(99, 102, 241, 0.4)',
        'jam-lg': '0 8px 48px rgba(99, 102, 241, 0.6)',
        recording: '0 4px 24px rgba(239, 68, 68, 0.4)',
      },
    },
  },
  plugins: [
    plugin(({ addUtilities, addComponents }) => {
      addUtilities({
        '.glass': {
          background: 'rgba(15, 23, 42, 0.8)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        },
        '.glass-light': {
          background: 'rgba(30, 41, 59, 0.6)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255,  0.06)',
        },
        '.glass-card': {
          background: 'rgba(15, 23, 42, 0.9)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
        },
        '.scrollbar-thin': {
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(99, 102, 241, 0.4) transparent',
        },
        '.scrollbar-none': {
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': {
            display: 'none',
          },
        },
        '.text-gradient': {
          background: 'linear-gradient(135deg, #a5b4fc, #818cf8)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        },
      });

      addComponents({
        '.btn-primary': {
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          color: 'white',
          fontWeight: '600',
          borderRadius: '0.75rem',
          padding: '0.625rem 1.25rem',
          transition: 'all 0.2s ease',
          border: 'none',
          cursor: 'pointer',
          '&:hover': {
            background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
            boxShadow: '0 4px 24px rgba(99, 102, 241, 0.5)',
            transform: 'translateY(-1px)',
          },
          '&:active': {
            transform: 'translateY(0)',
          },
          '&:disabled': {
            opacity: '0.5',
            cursor: 'not-allowed',
            transform: 'none',
          },
        },
        '.input-dark': {
          background: 'rgba(15, 23, 42, 0.8)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
          borderRadius: '0.75rem',
          color: 'white',
          padding: '0.625rem 1rem',
          transition: 'all 0.2s ease',
          '&:focus': {
            outline: 'none',
            borderColor: 'rgba(99, 102, 241, 0.6)',
            boxShadow: '0 0 0 3px rgba(99, 102, 241, 0.15)',
          },
          '&::placeholder': {
            color: 'rgba(148, 163, 184, 0.6)',
          },
        },
      });
    }),
  ],
};

export default config;
