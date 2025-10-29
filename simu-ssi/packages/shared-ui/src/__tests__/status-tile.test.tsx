import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusTile } from '../status-tile';

describe('StatusTile', () => {
  it('renders title and value', () => {
    render(<StatusTile title="Test" value="Valeur" />);
    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText('Valeur')).toBeInTheDocument();
  });
});
