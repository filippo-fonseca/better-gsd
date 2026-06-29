import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'bgsd canary-next',
  description: 'Minimal Next.js fixture for bgsd runtime-isolate tests',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
