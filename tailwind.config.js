/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        space: {
          950: '#020617',
          900: '#0b1120',
          800: '#111c33',
        },
      },
    },
  },
  plugins: [],
};
