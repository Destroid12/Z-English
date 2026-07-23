const fs = require('fs');
const path = require('path');

const pptDir = 'C:/Users/ziyad/.gemini/antigravity/scratch/Z-English/test_ppt/ppt';
const slidesDir = path.join(pptDir, 'slides');
const relsDir = path.join(slidesDir, '_rels');

let out = [];

function extractText(xml) {
    let text = [];
    let match;
    const regex = /<a:t[^>]*>(.*?)<\/a:t>/g;
    while ((match = regex.exec(xml)) !== null) {
        text.push(match[1]);
    }
    return text;
}

function extractImages(xml) {
    let images = [];
    let match;
    const regex = /Target=\"\.\.\/media\/([^\"\']+)\"/g;
    while ((match = regex.exec(xml)) !== null) {
        images.push(match[1]);
    }
    return images;
}

for (let i = 1; i <= 30; i++) {
    const slideFile = path.join(slidesDir, `slide${i}.xml`);
    const relFile = path.join(relsDir, `slide${i}.xml.rels`);
    
    if (!fs.existsSync(slideFile)) continue;
    
    const xml = fs.readFileSync(slideFile, 'utf8');
    const textPieces = extractText(xml);
    
    let images = [];
    if (fs.existsSync(relFile)) {
        const relXml = fs.readFileSync(relFile, 'utf8');
        images = extractImages(relXml);
    }
    
    out.push(`--- Slide ${i} ---`);
    out.push('TEXT: ' + textPieces.join(' | '));
    out.push('IMAGES: ' + images.join(', '));
}

console.log(out.join('\n'));
