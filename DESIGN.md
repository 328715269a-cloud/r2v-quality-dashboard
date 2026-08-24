# R2V Quality Dashboard Design System

## Overview

Light, information-dense operations dashboard for daily quality management. The visual system is restrained and familiar so users can scan metrics and tables quickly.

## Color

- Canvas: cool blue-tinted near white using `--canvas`.
- Surface: slightly lighter `--surface`.
- Ink and muted text: cool slate neutrals using `--ink` and `--muted`.
- Accent: blue `--accent`, reserved for current navigation, primary actions and interactive data.
- Semantic states: green success, amber warning, red danger, cyan P2.
- Charts use distinct OKLCH hues and always pair color with labels and values.

## Typography

- Font stack: Inter, Microsoft YaHei, PingFang SC, system UI.
- Dense data text remains compact; headings use weight and a modest size step rather than display typography.
- Numeric metrics use tabular alignment where comparison matters.

## Components

- App shell: dark left navigation, light work surface.
- Panels: subtle full border, small radius, restrained shadow.
- Tables: sticky headings, compact rows, horizontal overflow for wide datasets.
- Controls: 8px radius, visible keyboard focus, consistent primary and secondary actions.
- Status: text badge plus semantic tint, never color alone.
- Progressive sections: collapsed by default for secondary overview details; content renders only after expansion.

## Layout

- Desktop-first dense dashboard with responsive sidebar collapse.
- Primary metrics and action queues appear before detailed tables.
- Monitoring modules use one wide table plus one compact distribution chart rather than repeated card grids.

## Motion

- 150–220ms ease-out transitions for state changes only.
- No decorative page-load animation; reduced-motion preference disables transitions.
