import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import 'katex/dist/katex.min.css';
createRoot(document.getElementById('root')).render(<App/>);
