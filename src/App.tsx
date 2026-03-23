import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Stage, Layer, Image as KonvaImage, Transformer, Rect, Line, Text } from 'react-konva';
import useImage from 'use-image';
import { v4 as uuidv4 } from 'uuid';
import { jsPDF } from 'jspdf';
import { Upload, Download, Trash2, Smartphone, ZoomIn, ZoomOut, AlertCircle, FileText, Maximize, Image as ImageIcon, Copy, Loader2 } from 'lucide-react';

// 57cm x 100cm at 96 DPI
const CM_TO_PX = 37.7952755906;
const VIRTUAL_WIDTH = 57 * CM_TO_PX; // ~2154
const VIRTUAL_HEIGHT = 100 * CM_TO_PX; // ~3780

const cropTransparentPixels = (imageSource: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        resolve(imageSource);
        return;
      }
      ctx.drawImage(img, 0, 0);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
      let hasPixels = false;

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const alpha = data[(y * canvas.width + x) * 4 + 3];
          if (alpha > 5) { // Threshold for transparency
            hasPixels = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (!hasPixels) {
        resolve(imageSource);
        return;
      }

      const croppedWidth = maxX - minX + 1;
      const croppedHeight = maxY - minY + 1;

      if (croppedWidth === canvas.width && croppedHeight === canvas.height) {
        resolve(imageSource);
        return;
      }

      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = croppedWidth;
      croppedCanvas.height = croppedHeight;
      const croppedCtx = croppedCanvas.getContext('2d');
      if (!croppedCtx) {
        resolve(imageSource);
        return;
      }
      
      croppedCtx.drawImage(
        canvas,
        minX, minY, croppedWidth, croppedHeight,
        0, 0, croppedWidth, croppedHeight
      );

      resolve(croppedCanvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(imageSource);
    img.src = imageSource;
  });
};

const changeDpiDataUrl = (base64Image: string, dpi: number): string => {
  const data = atob(base64Image.split(',')[1]);
  const dataArray = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    dataArray[i] = data.charCodeAt(i);
  }

  const physChunk = new Uint8Array(21);
  physChunk[0] = 0; physChunk[1] = 0; physChunk[2] = 0; physChunk[3] = 9;
  physChunk[4] = 112; physChunk[5] = 72; physChunk[6] = 89; physChunk[7] = 115;
  const ppu = Math.round(dpi / 0.0254);
  physChunk[8] = (ppu >>> 24) & 0xFF; physChunk[9] = (ppu >>> 16) & 0xFF;
  physChunk[10] = (ppu >>> 8) & 0xFF; physChunk[11] = ppu & 0xFF;
  physChunk[12] = (ppu >>> 24) & 0xFF; physChunk[13] = (ppu >>> 16) & 0xFF;
  physChunk[14] = (ppu >>> 8) & 0xFF; physChunk[15] = ppu & 0xFF;
  physChunk[16] = 1;

  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[n] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 4; i < 17; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ physChunk[i]) & 0xFF];
  }
  crc = (crc ^ (-1)) >>> 0;
  physChunk[17] = (crc >>> 24) & 0xFF; physChunk[18] = (crc >>> 16) & 0xFF;
  physChunk[19] = (crc >>> 8) & 0xFF; physChunk[20] = crc & 0xFF;

  const chunks: Uint8Array[] = [];
  let offset = 8;
  while (offset < dataArray.length) {
    const length = (dataArray[offset] << 24) | (dataArray[offset+1] << 16) | (dataArray[offset+2] << 8) | dataArray[offset+3];
    const type = String.fromCharCode(dataArray[offset+4], dataArray[offset+5], dataArray[offset+6], dataArray[offset+7]);
    const chunk = dataArray.slice(offset, offset + 12 + length);
    if (type !== 'pHYs') {
      chunks.push(chunk);
    }
    offset += 12 + length;
  }

  const newArray = new Uint8Array(8 + chunks[0].length + physChunk.length + dataArray.length - 8 - chunks[0].length);
  newArray.set(dataArray.slice(0, 8), 0);
  newArray.set(chunks[0], 8);
  newArray.set(physChunk, 8 + chunks[0].length);
  
  let currentOffset = 8 + chunks[0].length + physChunk.length;
  for (let i = 1; i < chunks.length; i++) {
    newArray.set(chunks[i], currentOffset);
    currentOffset += chunks[i].length;
  }

  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < currentOffset; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(newArray.slice(i, i + chunkSize)));
  }
  return 'data:image/png;base64,' + btoa(binary);
};

interface ImageItem {
  id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  gabaritoId: string;
}

const URLImage = ({ image, isSelected, onSelect, onChange, onDragMove }: any) => {
  const [img] = useImage(image.url);
  const imageRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  useEffect(() => {
    if (isSelected && trRef.current && imageRef.current) {
      trRef.current.nodes([imageRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  return (
    <React.Fragment>
      <KonvaImage
        image={img}
        x={image.x}
        y={image.y}
        width={image.width}
        height={image.height}
        rotation={image.rotation}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        ref={imageRef}
        onDragMove={(e) => {
          if (onDragMove) {
            onDragMove(image.id, e.target.x(), e.target.y());
          }
        }}
        onDragEnd={(e) => {
          onChange({
            ...image,
            x: e.target.x(),
            y: e.target.y(),
          });
        }}
        onTransformEnd={(e) => {
          const node = imageRef.current;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();

          node.scaleX(1);
          node.scaleY(1);

          onChange({
            ...image,
            x: node.x(),
            y: node.y(),
            width: Math.max(5, node.width() * scaleX),
            height: Math.max(5, node.height() * scaleY),
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected && (
        <Transformer
          ref={trRef}
          anchorSize={10}
          anchorCornerRadius={0}
          borderStroke="#4285F4"
          borderStrokeWidth={1}
          anchorStroke="#4285F4"
          anchorFill="#ffffff"
          anchorStrokeWidth={1}
          padding={0}
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 5 || newBox.height < 5) {
              return oldBox;
            }
            return newBox;
          }}
        />
      )}
    </React.Fragment>
  );
};

export default function App() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scale, setScale] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [bgColor, setBgColor] = useState('transparent');
  const [isExporting, setIsExporting] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [orderName, setOrderName] = useState('');
  const [measurements, setMeasurements] = useState<any[]>([]);
  const [logoQuantity, setLogoQuantity] = useState<number>(1);
  const [largePrintWidth, setLargePrintWidth] = useState<number>(28);
  const [largePrintHeight, setLargePrintHeight] = useState<number>(40);
  const [largePrintQuantity, setLargePrintQuantity] = useState<number>(1);
  const [gabaritos, setGabaritos] = useState<string[]>(['1']);
  const [activeGabaritoId, setActiveGabaritoId] = useState<string>('1');
  const [selectionRect, setSelectionRect] = useState({ x: 0, y: 0, width: 0, height: 0, visible: false });
  const selectionStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRefs = useRef<Record<string, any>>({});

  const updateMeasurements = useCallback((targetId: string, targetX: number, targetY: number, currentImages: ImageItem[]) => {
    const targetImg = currentImages.find(img => img.id === targetId);
    if (!targetImg) {
      setMeasurements([]);
      return;
    }

    const currentRect = {
      x: targetX,
      y: targetY,
      width: targetImg.width,
      height: targetImg.height
    };

    let closestH: any = null;
    let closestV: any = null;

    // Check canvas edges
    const distLeft = currentRect.x;
    const distRight = VIRTUAL_WIDTH - (currentRect.x + currentRect.width);
    const distTop = currentRect.y;
    const distBottom = VIRTUAL_HEIGHT - (currentRect.y + currentRect.height);

    closestH = {
      type: 'horizontal',
      x: 0,
      y: currentRect.y + currentRect.height / 2,
      distance: distLeft,
      text: (distLeft / CM_TO_PX).toFixed(2) + ' cm'
    };

    if (distRight < distLeft) {
      closestH = {
        type: 'horizontal',
        x: currentRect.x + currentRect.width,
        y: currentRect.y + currentRect.height / 2,
        distance: distRight,
        text: (distRight / CM_TO_PX).toFixed(2) + ' cm'
      };
    }

    closestV = {
      type: 'vertical',
      x: currentRect.x + currentRect.width / 2,
      y: 0,
      distance: distTop,
      text: (distTop / CM_TO_PX).toFixed(2) + ' cm'
    };

    if (distBottom < distTop) {
      closestV = {
        type: 'vertical',
        x: currentRect.x + currentRect.width / 2,
        y: currentRect.y + currentRect.height,
        distance: distBottom,
        text: (distBottom / CM_TO_PX).toFixed(2) + ' cm'
      };
    }

    currentImages.forEach(img => {
      if (img.id === targetId || img.gabaritoId !== targetImg.gabaritoId) return;

      // Horizontal distance (requires vertical overlap)
      const overlapV = currentRect.y < img.y + img.height && currentRect.y + currentRect.height > img.y;
      if (overlapV) {
        let dist = -1;
        let startX = 0;
        let startY = Math.max(currentRect.y, img.y) + Math.min(currentRect.height, img.height) / 2;

        if (currentRect.x >= img.x + img.width) {
          dist = currentRect.x - (img.x + img.width);
          startX = img.x + img.width;
        } else if (img.x >= currentRect.x + currentRect.width) {
          dist = img.x - (currentRect.x + currentRect.width);
          startX = currentRect.x + currentRect.width;
        }

        if (dist >= 0 && (!closestH || dist < closestH.distance)) {
          closestH = {
            type: 'horizontal',
            x: startX,
            y: startY,
            distance: dist,
            text: (dist / CM_TO_PX).toFixed(2) + ' cm'
          };
        }
      }

      // Vertical distance (requires horizontal overlap)
      const overlapH = currentRect.x < img.x + img.width && currentRect.x + currentRect.width > img.x;
      if (overlapH) {
        let dist = -1;
        let startY = 0;
        let startX = Math.max(currentRect.x, img.x) + Math.min(currentRect.width, img.width) / 2;

        if (currentRect.y >= img.y + img.height) {
          dist = currentRect.y - (img.y + img.height);
          startY = img.y + img.height;
        } else if (img.y >= currentRect.y + currentRect.height) {
          dist = img.y - (currentRect.y + currentRect.height);
          startY = currentRect.y + currentRect.height;
        }

        if (dist >= 0 && (!closestV || dist < closestV.distance)) {
          closestV = {
            type: 'vertical',
            x: startX,
            y: startY,
            distance: dist,
            text: (dist / CM_TO_PX).toFixed(2) + ' cm'
          };
        }
      }
    });

    const newMeasurements = [];
    if (closestH) newMeasurements.push(closestH);
    if (closestV) newMeasurements.push(closestV);
    setMeasurements(newMeasurements);
  }, []);

  useEffect(() => {
    if (selectedIds.length === 1) {
      const img = images.find(i => i.id === selectedIds[0]);
      if (img) {
        updateMeasurements(selectedIds[0], img.x, img.y, images);
      }
    } else {
      setMeasurements([]);
    }
  }, [selectedIds, images, updateMeasurements]);

  const handleStageMouseDown = (e: any, gabId: string) => {
    const clickedOnEmpty = e.target === e.target.getStage();
    if (clickedOnEmpty) {
      setSelectedIds([]);
      setActiveGabaritoId(gabId);
      
      const pos = e.target.getStage().getPointerPosition();
      const scale = e.target.getStage().scaleX();
      selectionStart.current = {
        x: (pos.x - e.target.getStage().x()) / scale,
        y: (pos.y - e.target.getStage().y()) / scale
      };
      setSelectionRect({
        x: selectionStart.current.x,
        y: selectionStart.current.y,
        width: 0,
        height: 0,
        visible: true
      });
    }
  };

  const handleStageMouseMove = (e: any) => {
    if (!selectionRect.visible) return;
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    const scale = stage.scaleX();
    const currentX = (pos.x - stage.x()) / scale;
    const currentY = (pos.y - stage.y()) / scale;

    setSelectionRect({
      x: Math.min(selectionStart.current.x, currentX),
      y: Math.min(selectionStart.current.y, currentY),
      width: Math.abs(currentX - selectionStart.current.x),
      height: Math.abs(currentY - selectionStart.current.y),
      visible: true
    });
  };

  const handleStageMouseUp = (e: any, gabId: string) => {
    if (!selectionRect.visible) return;
    setSelectionRect(prev => ({ ...prev, visible: false }));
    
    const box = selectionRect;
    if (box.width === 0 || box.height === 0) return;

    const intersectingIds = images
      .filter(img => img.gabaritoId === gabId)
      .filter(img => {
        return (
          img.x < box.x + box.width &&
          img.x + img.width > box.x &&
          img.y < box.y + box.height &&
          img.y + img.height > box.y
        );
      })
      .map(img => img.id);

    if (intersectingIds.length > 0) {
      setSelectedIds(intersectingIds);
    }
  };

  useEffect(() => {
    const updateScale = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        // Add some padding
        const padding = 40;
        const scaleX = (width - padding) / VIRTUAL_WIDTH;
        const scaleY = (height - padding) / VIRTUAL_HEIGHT;
        setScale(Math.min(scaleX, scaleY));
      }
    };

    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  const handleDuplicate = useCallback(() => {
    if (selectedIds.length === 0) return;
    const imgsToCopy = images.filter((img) => selectedIds.includes(img.id));
    if (imgsToCopy.length === 0) return;

    const gap = 1 * CM_TO_PX;
    const newImages = imgsToCopy.map((imgToCopy) => {
      let newX = imgToCopy.x + imgToCopy.width + gap;
      let newY = imgToCopy.y;

      if (newX + imgToCopy.width > VIRTUAL_WIDTH) {
        newX = imgToCopy.x;
        newY = imgToCopy.y + imgToCopy.height + gap;
      }

      return {
        ...imgToCopy,
        id: uuidv4(),
        x: newX,
        y: newY,
      };
    });
    
    setImages((prev) => [...prev, ...newImages]);
    setTimeout(() => setSelectedIds(newImages.map(img => img.id)), 0);
  }, [selectedIds, images]);

  // Keyboard delete and duplicate support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length > 0) {
          setImages((prev) => prev.filter((img) => !selectedIds.includes(img.id)));
          setSelectedIds([]);
        }
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleDuplicate();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, handleDuplicate]);

  const handleWheel = useCallback((e: any) => {
    e.evt.preventDefault();
    const scaleBy = 1.1;
    setZoomLevel((prevZoom) => {
      const newZoom = e.evt.deltaY < 0 ? prevZoom * scaleBy : prevZoom / scaleBy;
      return Math.min(Math.max(0.25, newZoom), 5);
    });
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach(async (file) => {
        const url = URL.createObjectURL(file);
        const croppedUrl = await cropTransparentPixels(url);
        
        const img = new window.Image();
        img.src = croppedUrl;
        img.onload = () => {
          // Calculate initial size to fit within 20cm x 20cm roughly
          const maxInitialSize = 20 * CM_TO_PX;
          let width = img.width;
          let height = img.height;
          
          if (width > maxInitialSize || height > maxInitialSize) {
            const ratio = Math.min(maxInitialSize / width, maxInitialSize / height);
            width *= ratio;
            height *= ratio;
          }

          const newId = uuidv4();
          setImages((prev) => [
            ...prev,
            {
              id: newId,
              url: croppedUrl,
              x: VIRTUAL_WIDTH / 2 - width / 2,
              y: VIRTUAL_HEIGHT / 2 - height / 2,
              width,
              height,
              rotation: 0,
              gabaritoId: activeGabaritoId,
            },
          ]);
          setSelectedIds([newId]);
        };
      });
    }
  };

  const applyLogoPeito = () => {
    if (selectedIds.length !== 1) return;
    const sourceImg = images.find(img => img.id === selectedIds[0]);
    if (!sourceImg) return;

    const targetSizePx = 9 * CM_TO_PX;
    const spacingPx = 1 * CM_TO_PX;

    // Calculate scale to fit within 9x9cm while maintaining aspect ratio
    const imgScale = Math.min(targetSizePx / sourceImg.width, targetSizePx / sourceImg.height);
    const newWidth = sourceImg.width * imgScale;
    const newHeight = sourceImg.height * imgScale;

    const newImages: any[] = [];
    
    let currentX = sourceImg.x;
    let currentY = sourceImg.y;

    for (let i = 0; i < logoQuantity; i++) {
      if (currentX + newWidth > VIRTUAL_WIDTH) {
        currentX = 0; // Wrap to left edge
        currentY += newHeight + spacingPx;
      }

      if (currentY + newHeight > VIRTUAL_HEIGHT) {
        alert('Atenção: A quantidade excede o limite do gabarito.');
        break;
      }

      newImages.push({
        ...sourceImg,
        id: `logo-${Date.now()}-${i}`,
        width: newWidth,
        height: newHeight,
        x: currentX,
        y: currentY
      });

      currentX += newWidth + spacingPx;
    }

    setImages((prev) => {
      const filtered = prev.filter(img => img.id !== selectedIds[0]);
      return [...filtered, ...newImages];
    });
    setSelectedIds([]);
  };

  const applyLargePrint = () => {
    if (selectedIds.length !== 1) return;
    const sourceImg = images.find(img => img.id === selectedIds[0]);
    if (!sourceImg) return;

    const targetWidthPx = largePrintWidth * CM_TO_PX;
    const targetHeightPx = largePrintHeight * CM_TO_PX;
    const spacingPx = 1 * CM_TO_PX;

    // Calculate scale to fit within target dimensions while maintaining aspect ratio
    const imgScale = Math.min(targetWidthPx / sourceImg.width, targetHeightPx / sourceImg.height);
    const newWidth = sourceImg.width * imgScale;
    const newHeight = sourceImg.height * imgScale;

    const newImages: any[] = [];
    
    let currentX = sourceImg.x;
    let currentY = sourceImg.y;

    for (let i = 0; i < largePrintQuantity; i++) {
      if (currentX + newWidth > VIRTUAL_WIDTH) {
        currentX = 0; // Wrap to left edge
        currentY += newHeight + spacingPx;
      }

      if (currentY + newHeight > VIRTUAL_HEIGHT) {
        alert('Atenção: A quantidade excede o limite do gabarito.');
        break;
      }

      newImages.push({
        ...sourceImg,
        id: `large-${Date.now()}-${i}`,
        width: newWidth,
        height: newHeight,
        x: currentX,
        y: currentY
      });

      currentX += newWidth + spacingPx;
    }

    setImages((prev) => {
      const filtered = prev.filter(img => img.id !== selectedIds[0]);
      return [...filtered, ...newImages];
    });
    setSelectedIds([]);
  };

  const handleDelete = () => {
    if (selectedIds.length > 0) {
      setImages((prev) => prev.filter((img) => !selectedIds.includes(img.id)));
      setSelectedIds([]);
    }
  };

  const downloadPNG = async () => {
    setIsExporting(true);
    setSelectedIds([]);
    
    const safeFileName = `${customerName.trim()}_${orderName.trim()}`.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'pedido';
    
    setTimeout(async () => {
      try {
        const currentScale = scale * zoomLevel;
        // 300 DPI = 3.125x of 96 DPI (virtual resolution)
        const targetPixelRatio = 3.125 / currentScale;
        
        for (let i = 0; i < gabaritos.length; i++) {
          const gabaritoId = gabaritos[i];
          const stage = stageRefs.current[gabaritoId];
          if (!stage) continue;

          let dataUrl;
          try {
            dataUrl = stage.toDataURL({ 
              pixelRatio: targetPixelRatio,
              mimeType: 'image/png'
            });
            dataUrl = changeDpiDataUrl(dataUrl, 300);
          } catch (e) {
            console.warn('Failed to export at 300 DPI, falling back to 200 DPI', e);
            dataUrl = stage.toDataURL({ 
              pixelRatio: 2.083 / currentScale, // 200 DPI
              mimeType: 'image/png'
            });
            dataUrl = changeDpiDataUrl(dataUrl, 200);
          }
          
          const link = document.createElement('a');
          link.download = `dtf_${safeFileName}_gabarito_${i + 1}.png`;
          link.href = dataUrl;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          // Wait a bit to let the browser process the download and free memory
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      } catch (error) {
        console.error('Error generating PNG:', error);
        alert('Erro ao gerar PNG. Tente com menos imagens ou imagens menores.');
      } finally {
        setIsExporting(false);
      }
    }, 100);
  };

  const generatePDF = async () => {
    setIsExporting(true);
    setSelectedIds([]);
    
    const safeFileName = `${customerName.trim()}_${orderName.trim()}`.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'pedido';
    
    // Wait for state update and transformer to disappear
    setTimeout(async () => {
      try {
        const currentScale = scale * zoomLevel;
        // 300 DPI = 3.125x of 96 DPI (virtual resolution)
        const targetPixelRatio = 3.125 / currentScale;
        
        for (let i = 0; i < gabaritos.length; i++) {
          const gabaritoId = gabaritos[i];
          const stage = stageRefs.current[gabaritoId];
          if (!stage) continue;

          let dataUrl;
          try {
            // Try high-res data URL (300 DPI)
            dataUrl = stage.toDataURL({ 
              pixelRatio: targetPixelRatio,
              mimeType: 'image/png'
            });
            dataUrl = changeDpiDataUrl(dataUrl, 300);
          } catch (e) {
            console.warn('Failed to export at 300 DPI, falling back to 200 DPI', e);
            dataUrl = stage.toDataURL({ 
              pixelRatio: 2.083 / currentScale, // 200 DPI
              mimeType: 'image/png'
            });
            dataUrl = changeDpiDataUrl(dataUrl, 200);
          }
          
          // 570mm x 1000mm
          const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: [570, 1000]
          });

          // Use FAST compression to prevent color corruption in some PDF readers
          pdf.addImage(dataUrl, 'PNG', 0, 0, 570, 1000, undefined, 'FAST');
          pdf.save(`dtf_${safeFileName}_gabarito_${i + 1}.pdf`);

          // Wait a bit to let the browser process the download and free memory
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      } catch (error) {
        console.error('Error generating PDF:', error);
        alert('Erro ao gerar PDF. Tente com menos imagens ou imagens menores.');
      } finally {
        setIsExporting(false);
      }
    }, 100);
  };

  const sendToWhatsApp = () => {
    const message = encodeURIComponent(`Olá! Segue o meu pedido de impressão DTF (57x100cm).\n\n*Cliente:* ${customerName}\n*Contato:* ${customerPhone}\n*Pedido:* ${orderName}\n\nO arquivo PDF/PNG será enviado logo em seguida.`);
    window.open(`https://wa.me/5515996526796?text=${message}`, '_blank');
  };

  const isFormValid = customerName.trim() !== '' && customerPhone.trim() !== '' && orderName.trim() !== '';
  const canExport = images.length > 0 && isFormValid && !isExporting;

  return (
    <div className="flex h-screen bg-gray-50 font-sans">
      {/* Sidebar */}
      <div className="w-80 bg-white shadow-lg flex flex-col z-10">
        <div className="p-6 border-b border-gray-100 flex items-center gap-4">
          <img src="https://i.ibb.co/ymB6hsrs/Camada-1.png" alt="Studio DTF MTS Logo" className="w-20 h-20 object-contain rounded-md" />
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight leading-tight">Studio DTF MTS</h1>
            <p className="text-sm text-gray-500 mt-1">Gabarito 57x100 cm</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Gabaritos Section */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">Gabaritos</h2>
              <button
                onClick={() => {
                  const newId = uuidv4();
                  setGabaritos([...gabaritos, newId]);
                  setActiveGabaritoId(newId);
                }}
                className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded hover:bg-indigo-200 font-medium transition-colors"
              >
                + Adicionar
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {gabaritos.map((gabId, index) => (
                <div key={gabId} className="flex items-center">
                  <button
                    onClick={() => setActiveGabaritoId(gabId)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                      activeGabaritoId === gabId
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {index + 1}
                  </button>
                  {gabaritos.length > 1 && (
                    <button
                      onClick={() => {
                        const newGabaritos = gabaritos.filter(id => id !== gabId);
                        setGabaritos(newGabaritos);
                        if (activeGabaritoId === gabId) {
                          setActiveGabaritoId(newGabaritos[0]);
                        }
                        // Also remove images from this gabarito
                        setImages((prev) => prev.filter(img => img.gabaritoId !== gabId));
                      }}
                      className={`px-2 py-1.5 text-sm font-medium rounded-r-md border border-l-0 ${
                        activeGabaritoId === gabId
                          ? 'bg-indigo-700 text-white border-indigo-700'
                          : 'bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200 hover:text-red-600'
                      }`}
                      title="Remover Gabarito"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Upload Section */}
          <div className="space-y-3 pt-4 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">Adicionar Imagens</h2>
            <p className="text-xs text-gray-500">As imagens serão adicionadas ao Gabarito {gabaritos.indexOf(activeGabaritoId) + 1}</p>
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-indigo-300 rounded-xl cursor-pointer bg-indigo-50 hover:bg-indigo-100 transition-colors">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <Upload className="w-8 h-8 text-indigo-500 mb-2" />
                <p className="text-sm text-indigo-600 font-medium">Clique para enviar</p>
                <p className="text-xs text-indigo-400 mt-1">PNG transparente recomendado</p>
              </div>
              <input type="file" className="hidden" multiple accept="image/png, image/jpeg" onChange={handleFileUpload} />
            </label>
          </div>

          {/* Tools */}
          <div className="space-y-3 pt-4 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">Ferramentas</h2>
            
            {/* Dimensions */}
            {selectedIds.length === 1 && images.find(img => img.id === selectedIds[0]) && (
              <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                <p className="text-xs text-gray-500 uppercase font-semibold mb-1">Tamanho na Impressão</p>
                <div className="flex justify-between text-sm font-medium text-gray-900">
                  <span>L: {(images.find(img => img.id === selectedIds[0])!.width / CM_TO_PX).toFixed(1)} cm</span>
                  <span>A: {(images.find(img => img.id === selectedIds[0])!.height / CM_TO_PX).toFixed(1)} cm</span>
                </div>
              </div>
            )}

            {/* Logo Peito Tool */}
            {selectedIds.length === 1 && images.find(img => img.id === selectedIds[0]) && (
              <div className="bg-indigo-50 p-3 rounded-lg border border-indigo-100 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-indigo-900">Logo Peito (9x9 cm)</p>
                  <p className="text-xs text-indigo-700 mt-0.5">Redimensiona e duplica com 1cm de espaço.</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={logoQuantity}
                    onChange={(e) => setLogoQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-20 px-2 py-1.5 text-sm border border-indigo-200 rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    placeholder="Qtd"
                  />
                  <button
                    onClick={applyLogoPeito}
                    className="flex-1 bg-indigo-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-indigo-700 transition-colors"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}

            {/* Estampa Grande Tool */}
            {selectedIds.length === 1 && images.find(img => img.id === selectedIds[0]) && (
              <div className="bg-emerald-50 p-3 rounded-lg border border-emerald-100 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-emerald-900">Estampa Grande</p>
                  <p className="text-xs text-emerald-700 mt-0.5">Defina o tamanho máximo (cm) e a quantidade.</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-1 w-16">
                    <label className="text-[10px] font-medium text-emerald-800 uppercase">Larg.</label>
                    <input
                      type="number"
                      min="1"
                      value={largePrintWidth}
                      onChange={(e) => setLargePrintWidth(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full px-2 py-1.5 text-sm border border-emerald-200 rounded-md focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1 w-16">
                    <label className="text-[10px] font-medium text-emerald-800 uppercase">Alt.</label>
                    <input
                      type="number"
                      min="1"
                      value={largePrintHeight}
                      onChange={(e) => setLargePrintHeight(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full px-2 py-1.5 text-sm border border-emerald-200 rounded-md focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1 w-16">
                    <label className="text-[10px] font-medium text-emerald-800 uppercase">Qtd.</label>
                    <input
                      type="number"
                      min="1"
                      value={largePrintQuantity}
                      onChange={(e) => setLargePrintQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full px-2 py-1.5 text-sm border border-emerald-200 rounded-md focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    />
                  </div>
                </div>
                <button
                  onClick={applyLargePrint}
                  className="w-full bg-emerald-600 text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-emerald-700 transition-colors"
                >
                  Aplicar Estampa
                </button>
              </div>
            )}

            <button
              onClick={handleDelete}
              disabled={selectedIds.length === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              <Trash2 className="w-4 h-4" />
              Remover Imagem Selecionada
            </button>
            <p className="text-xs text-center text-gray-400">Você também pode usar a tecla Delete</p>
          </div>

          {/* Background Color */}
          <div className="space-y-3 pt-4 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">Fundo (Visualização)</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setBgColor('transparent')}
                className={`flex-1 h-10 rounded-lg border-2 ${bgColor === 'transparent' ? 'border-indigo-500' : 'border-gray-200'} checkerboard`}
                title="Transparente"
              />
              <button
                onClick={() => setBgColor('white')}
                className={`flex-1 h-10 rounded-lg border-2 bg-white ${bgColor === 'white' ? 'border-indigo-500' : 'border-gray-200'}`}
                title="Branco"
              />
              <button
                onClick={() => setBgColor('black')}
                className={`flex-1 h-10 rounded-lg border-2 bg-black ${bgColor === 'black' ? 'border-indigo-500' : 'border-gray-200'}`}
                title="Preto"
              />
            </div>
            <p className="text-xs text-gray-500">Apenas visual. O PDF sempre terá fundo transparente.</p>
          </div>

          {/* Customer Data Form */}
          <div className="space-y-3 pt-4 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">Dados do Pedido <span className="text-red-500">*</span></h2>
            <input
              type="text"
              placeholder="Nome do Cliente"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="text"
              placeholder="Número do WhatsApp"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="text"
              placeholder="Nome do Pedido (Ex: Camisetas Evento)"
              value={orderName}
              onChange={(e) => setOrderName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {!isFormValid && images.length > 0 && (
              <p className="text-xs text-red-500 font-medium">Preencha os dados acima para liberar o download.</p>
            )}
          </div>

          {/* Info */}
          <div className="bg-blue-50 p-4 rounded-xl flex gap-3 items-start">
            <AlertCircle className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">Dicas para melhor qualidade:</p>
              <ul className="list-disc pl-4 space-y-1 text-blue-700/80">
                <li>Use imagens PNG com fundo transparente.</li>
                <li>Evite esticar imagens pequenas demais.</li>
                <li>O fundo quadriculado não sairá na impressão.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 border-t border-gray-100 space-y-3 bg-gray-50">
          <button
            onClick={downloadPNG}
            disabled={!canExport}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium shadow-sm"
          >
            {isExporting ? (
              <span className="animate-pulse">Gerando...</span>
            ) : (
              <>
                <ImageIcon className="w-5 h-5" />
                Baixar PNG (Recomendado)
              </>
            )}
          </button>

          <button
            onClick={generatePDF}
            disabled={!canExport}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white border-2 border-indigo-600 text-indigo-600 rounded-xl hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium shadow-sm"
          >
            <FileText className="w-5 h-5" />
            Gerar PDF
          </button>
          
          <button
            onClick={sendToWhatsApp}
            disabled={!canExport}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#25D366] text-white rounded-xl hover:bg-[#20bd5a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium shadow-sm"
          >
            <Smartphone className="w-5 h-5" />
            Enviar para WhatsApp
          </button>
        </div>
      </div>

      {/* Canvas Area */}
      <div className="flex-1 relative flex flex-col overflow-hidden bg-gray-200">
        <div className="flex-1 overflow-auto" ref={containerRef}>
          <div className="min-h-full min-w-max flex flex-row items-start justify-start p-8 gap-8">
            {gabaritos.map((gabId, index) => {
              const gabaritoImages = images.filter(img => img.gabaritoId === gabId);
              return (
                <div key={gabId} className="flex flex-col items-center">
                  <div className="mb-2 flex items-center justify-between w-full px-2">
                    <h3 className="text-lg font-bold text-gray-700">Gabarito {index + 1}</h3>
                    {activeGabaritoId === gabId && (
                      <span className="text-xs font-medium bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full">
                        Ativo
                      </span>
                    )}
                  </div>
                  <div 
                    onClick={() => setActiveGabaritoId(gabId)}
                    className={`shadow-2xl transition-all cursor-pointer ${
                      activeGabaritoId === gabId ? 'ring-4 ring-indigo-500' : 'ring-1 ring-gray-900/5 hover:ring-2 hover:ring-indigo-300'
                    } ${
                      bgColor === 'transparent' ? 'checkerboard' :
                      bgColor === 'black' ? 'bg-black' : 'bg-white'
                    }`}
                    style={{
                      width: VIRTUAL_WIDTH * scale * zoomLevel,
                      height: VIRTUAL_HEIGHT * scale * zoomLevel,
                    }}
                  >
                    <Stage
                      width={VIRTUAL_WIDTH * scale * zoomLevel}
                      height={VIRTUAL_HEIGHT * scale * zoomLevel}
                      scaleX={scale * zoomLevel}
                      scaleY={scale * zoomLevel}
                      onMouseDown={(e) => handleStageMouseDown(e, gabId)}
                      onTouchStart={(e) => handleStageMouseDown(e, gabId)}
                      onMouseMove={handleStageMouseMove}
                      onTouchMove={handleStageMouseMove}
                      onMouseUp={(e) => handleStageMouseUp(e, gabId)}
                      onTouchEnd={(e) => handleStageMouseUp(e, gabId)}
                      onWheel={handleWheel}
                      ref={(node) => { stageRefs.current[gabId] = node; }}
                    >
                      <Layer>
                        {gabaritoImages.map((img) => {
                          const originalIndex = images.findIndex(i => i.id === img.id);
                          return (
                            <URLImage
                              key={img.id}
                              image={img}
                              isSelected={selectedIds.includes(img.id)}
                              onSelect={(e: any) => {
                                setActiveGabaritoId(gabId);
                                const metaPressed = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
                                if (metaPressed) {
                                  if (selectedIds.includes(img.id)) {
                                    setSelectedIds(selectedIds.filter(id => id !== img.id));
                                  } else {
                                    setSelectedIds([...selectedIds, img.id]);
                                  }
                                } else {
                                  setSelectedIds([img.id]);
                                }
                              }}
                              onChange={(newAttrs: any) => {
                                setImages((prev) => {
                                  const imgs = prev.slice();
                                  imgs[originalIndex] = newAttrs;
                                  return imgs;
                                });
                              }}
                              onDragMove={(id: string, x: number, y: number) => {
                                updateMeasurements(id, x, y, images);
                              }}
                            />
                          );
                        })}
                        
                        {/* Selection Rect */}
                        {selectionRect.visible && activeGabaritoId === gabId && (
                          <Rect
                            x={selectionRect.x}
                            y={selectionRect.y}
                            width={selectionRect.width}
                            height={selectionRect.height}
                            fill="rgba(66, 133, 244, 0.2)"
                            stroke="#4285F4"
                            strokeWidth={1}
                          />
                        )}

                        {/* Measurements Layer */}
                        {!isExporting && activeGabaritoId === gabId && measurements.map((m, i) => {
                          const isH = m.type === 'horizontal';
                          const linePoints = isH
                            ? [m.x, m.y, m.x + m.distance, m.y]
                            : [m.x, m.y, m.x, m.y + m.distance];

                          const textWidth = 120;
                          const textHeight = 40;
                          const rectX = isH ? m.x + m.distance / 2 - textWidth / 2 : m.x - textWidth / 2;
                          const rectY = isH ? m.y - textHeight / 2 : m.y + m.distance / 2 - textHeight / 2;

                          return (
                            <React.Fragment key={`measure-${i}`}>
                              <Line points={linePoints} stroke="#e83a9e" strokeWidth={3} dash={[8, 8]} />
                              <Line points={isH ? [m.x, m.y - 15, m.x, m.y + 15] : [m.x - 15, m.y, m.x + 15, m.y]} stroke="#e83a9e" strokeWidth={3} />
                              <Line points={isH ? [m.x + m.distance, m.y - 15, m.x + m.distance, m.y + 15] : [m.x - 15, m.y + m.distance, m.x + 15, m.y + m.distance]} stroke="#e83a9e" strokeWidth={3} />
                              <Rect x={rectX} y={rectY} width={textWidth} height={textHeight} fill="#e83a9e" cornerRadius={8} />
                              <Text x={rectX} y={rectY + 8} width={textWidth} text={m.text} fontSize={24} fontStyle="bold" fill="white" align="center" fontFamily="sans-serif" />
                            </React.Fragment>
                          );
                        })}
                      </Layer>
                    </Stage>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Floating Zoom Controls */}
        <div className="absolute bottom-6 right-6 flex items-center bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-10">
          <button onClick={() => setZoomLevel(z => Math.max(0.25, z - 0.25))} className="p-2 hover:bg-gray-100 rounded text-gray-700">
            <ZoomOut className="w-5 h-5" />
          </button>
          <span className="px-3 text-sm font-medium text-gray-700 min-w-[4rem] text-center">
            {Math.round(zoomLevel * 100)}%
          </span>
          <button onClick={() => setZoomLevel(z => Math.min(4, z + 0.25))} className="p-2 hover:bg-gray-100 rounded text-gray-700">
            <ZoomIn className="w-5 h-5" />
          </button>
          <div className="w-px h-6 bg-gray-200 mx-1"></div>
          <button onClick={() => setZoomLevel(1)} className="p-2 hover:bg-gray-100 rounded text-gray-700" title="Ajustar à tela">
            <Maximize className="w-4 h-4" />
          </button>
        </div>

        {/* Floating Action Buttons */}
        {selectedIds.length > 0 && (
          <div className="absolute top-4 right-4 flex gap-2 z-10">
            <button
              onClick={handleDuplicate}
              className="bg-blue-500 text-white p-3 rounded-full shadow-lg hover:bg-blue-600 transition-colors"
              title="Duplicar Imagem (Ctrl+D)"
            >
              <Copy className="w-6 h-6" />
            </button>
            <button
              onClick={handleDelete}
              className="bg-red-500 text-white p-3 rounded-full shadow-lg hover:bg-red-600 transition-colors"
              title="Excluir Imagem (Delete)"
            >
              <Trash2 className="w-6 h-6" />
            </button>
          </div>
        )}

        {/* Exporting Balloon */}
        {isExporting && (
          <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 bg-indigo-600 text-white px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 z-50 animate-bounce">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="font-medium text-lg">Aguarde o download, não feche a aba...</span>
          </div>
        )}
      </div>
    </div>
  );
}
