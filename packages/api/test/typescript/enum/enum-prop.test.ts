import path from 'path';
import { parseFiles } from '../../../src/index';

describe('enum-prop', () => {
  it('members-comments', () => {
    const results = parseFiles([
      path.resolve(__dirname, 'members-comments.ts'),
    ]);
    expect(results).toEqual({
      TextAlignment: {
        name: 'TextAlignment',
        kind: 4,
        properties: [
          {
            kind: 1,
            type: 'Left',
            value: 'left',
            description: 'Left-aligns the text.',
          },
          {
            kind: 1,
            type: 'Right',
            value: 'right',
            description: 'Right-aligns the text.',
          },
          {
            kind: 1,
            type: 'Center',
            value: 'center',
            description: 'Centers the text horizontally.',
          },
        ],
        description: 'Controls the alignment of text when printed.',
      },
    });
  });
  it('enum-namespace', () => {
    const results = parseFiles([path.resolve(__dirname, 'enum-namespace.ts')]);
    expect(results).toEqual({
      PropDiagnostic: {
        name: 'PropDiagnostic',
        kind: 15,
        properties: [
          {
            name: 'category',
            kind: 5,
            type: 'ts.DiagnosticCategory',
            description: 'error category',
            properties: [
              {
                name: 'Warning',
                parent: 'DiagnosticCategory',
                kind: 2,
                value: 0,
              },
              {
                name: 'Error',
                parent: 'DiagnosticCategory',
                kind: 2,
                value: 1,
              },
              {
                name: 'Suggestion',
                parent: 'DiagnosticCategory',
                kind: 2,
                value: 2,
              },
              {
                name: 'Message',
                parent: 'DiagnosticCategory',
                kind: 2,
                value: 3,
              },
            ],
          },
        ],
        description: 'diagnostics row data',
      },
    });
  });
  it('string-enum', () => {
    const results = parseFiles([path.resolve(__dirname, 'string-enum.ts')]);
    expect(results).toEqual({
      StringEnums: {
        name: 'StringEnums',
        kind: 5,
        properties: [
          {
            name: 'Up',
            kind: 1,
            value: 'UP',
          },
          {
            name: 'Down',
            kind: 1,
            value: 'DOWN',
          },
          {
            name: 'Left',
            kind: 1,
            value: 'LEFT',
          },
          {
            name: 'Right',
            kind: 1,
            value: 'RIGHT',
            description: 'right enum property',
          },
        ],
        description: 'string values enum',
      },
    });
  });
  it('initialized', () => {
    const results = parseFiles([path.resolve(__dirname, 'initialized.ts')]);
    expect(results).toEqual({
      InitializedEnum: {
        description: 'this is an enum with an initialized element',
        kind: 5,
        name: 'InitializedEnum',
        properties: [
          {
            description: 'enum starts at 1',
            name: 'Up',
            kind: 2,
            value: 1,
          },
          {
            description: 'second element',
            name: 'Down',
          },
          {
            name: 'Left',
          },
          {
            name: 'Right',
          },
        ],
      },
    });
  });
});
