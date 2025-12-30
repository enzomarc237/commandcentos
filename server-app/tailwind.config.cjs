const defaultTheme = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', ...defaultTheme.fontFamily.sans],
      },
      colors: {
        primary: {
          DEFAULT: '#2563eb',
          foreground: '#ffffff'
        },
        success: '#16a34a',
        warning: '#f59e0b',
        danger: '#dc2626'
      }
    }
  },
  plugins: [require('@tailwindcss/forms')]
};
