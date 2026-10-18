import { Router } from 'express';

export const categoriesRouter = Router();

export const DEFAULT_CATEGORIES = [
  { id: 'kitchen', en: 'Kitchen Essentials', mr: 'स्वयंपाकघरातील साहित्य' },
  { id: 'grains', en: 'Grains and Pulses', mr: 'धान्य व डाळी' },
  { id: 'spices', en: 'Spices', mr: 'मसाले' },
  { id: 'cleaning', en: 'Cleaning Supplies', mr: 'स्वच्छतेचे साहित्य' },
  { id: 'personal', en: 'Personal Care', mr: 'वैयक्तिक वापराचे साहित्य' },
  { id: 'home', en: 'Home Essentials', mr: 'घरगुती साहित्य' },
  { id: 'custom', en: 'Other Essentials', mr: 'इतर साहित्य' }
];

export const DEFAULT_UNITS = [
  { id: 'kg', en: 'kg', mr: 'किलो' },
  { id: 'g', en: 'g', mr: 'ग्रॅम' },
  { id: 'litre', en: 'litre', mr: 'लिटर' },
  { id: 'ml', en: 'ml', mr: 'मि.ली.' },
  { id: 'piece', en: 'piece', mr: 'नग' },
  { id: 'pack', en: 'pack', mr: 'पाकीट' },
  { id: 'dozen', en: 'dozen', mr: 'डझन' }
];

categoriesRouter.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      categories: DEFAULT_CATEGORIES,
      units: DEFAULT_UNITS
    }
  });
});
