import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'resources', 'samples');

interface Slide {
  title: string;
  subtitle?: string;
  bullets: string[];
  accent: string;
}

const SLIDES: Slide[] = [
  {
    title: 'Q4 Product Review',
    subtitle: 'Annual revenue, launches, and customer feedback',
    bullets: ['Revenue growth', 'New feature launches', 'Customer feedback'],
    accent: '#3b82f6',
  },
  {
    title: 'Revenue',
    subtitle: '+32% year over year',
    bullets: [
      'Driven by enterprise contracts',
      'Financial services sector leading',
      'Average contract value: $40k → $55k',
    ],
    accent: '#10b981',
  },
  {
    title: 'New Features',
    subtitle: 'Three major launches this quarter',
    bullets: [
      'Real-time collaboration module',
      'Advanced analytics dashboard',
      'Mobile offline mode',
      'Collab: 60% adoption in 2 weeks',
    ],
    accent: '#f59e0b',
  },
  {
    title: 'Customer Feedback',
    subtitle: 'NPS climbed 42 → 58',
    bullets: [
      'Performance improvements praised',
      'New onboarding flow well-received',
      'Search experience speed highlighted',
    ],
    accent: '#a855f7',
  },
  {
    title: 'Looking Ahead',
    subtitle: 'Q1 next year priorities',
    bullets: [
      'AI-powered recommendations',
      'Expand into European market',
      'Double the support team headcount',
    ],
    accent: '#ef4444',
  },
];

function drawSlide(doc: PDFKit.PDFDocument, slide: Slide, idx: number, total: number): void {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 60;

  // Background gradient strip on left
  doc.save();
  doc.rect(0, 0, 12, pageHeight).fill(slide.accent);
  doc.restore();

  // Slide number top-right
  doc
    .fillColor('#9ca3af')
    .fontSize(11)
    .font('Helvetica')
    .text(`Slide ${idx + 1} / ${total}`, pageWidth - 140, 36, { width: 100, align: 'right' });

  // Title
  doc
    .fillColor('#111827')
    .fontSize(38)
    .font('Helvetica-Bold')
    .text(slide.title, margin, 100, { width: pageWidth - margin * 2 });

  // Subtitle
  if (slide.subtitle) {
    doc
      .fillColor(slide.accent)
      .fontSize(18)
      .font('Helvetica')
      .text(slide.subtitle, margin, 160, { width: pageWidth - margin * 2 });
  }

  // Divider
  doc
    .strokeColor('#e5e7eb')
    .lineWidth(1)
    .moveTo(margin, 220)
    .lineTo(pageWidth - margin, 220)
    .stroke();

  // Bullets
  let y = 260;
  doc.fillColor('#1f2937').fontSize(20).font('Helvetica');
  for (const b of slide.bullets) {
    doc.circle(margin + 8, y + 10, 4).fill(slide.accent);
    doc.fillColor('#1f2937').text(b, margin + 28, y, { width: pageWidth - margin * 2 - 28 });
    y += 44;
  }

  // Footer
  doc
    .fillColor('#9ca3af')
    .fontSize(10)
    .font('Helvetica')
    .text('Scripter sample deck · resources/samples/slides.pdf', margin, pageHeight - 40, {
      width: pageWidth - margin * 2,
      align: 'left',
    });
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const pdfPath = join(OUT_DIR, 'slides.pdf');
  const doc = new PDFDocument({ size: [960, 540], margin: 0 });
  const stream = createWriteStream(pdfPath);
  doc.pipe(stream);

  SLIDES.forEach((slide, idx) => {
    if (idx > 0) doc.addPage();
    drawSlide(doc, slide, idx, SLIDES.length);
  });

  doc.end();
  stream.on('finish', () => {
    console.log(`Wrote ${SLIDES.length} slides to ${pdfPath}`);
  });
}

main();
