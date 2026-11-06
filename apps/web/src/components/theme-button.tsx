import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme';
import { Button } from './ui';

export function ThemeButton() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환';
  return (
    <Button variant="ghost" size="icon" onClick={toggle} title={label} aria-label={label}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}
