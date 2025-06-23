import React from 'react';
import AppRouter from './router';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';

// A basic theme for now, can be customized later
const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2', // Example primary color
    },
    secondary: {
      main: '#dc004e', // Example secondary color
    },
  },
});

const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline /> {/* MUI's CSS reset and baseline styles */}
      <AppRouter />
    </ThemeProvider>
  );
};

export default App;
