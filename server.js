require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs'); // Node's File System module to delete temp files
const { ImageAnnotatorClient } = require('@google-cloud/vision'); // Google Vision API

const app = express();
const port = process.env.PORT || 3000; // Use environment variable for deployment

// Initialize Google Vision Client
const visionClient = new ImageAnnotatorClient();

// Set up Multer to store files in a temporary 'uploads' directory
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Helper function to perform verification checks
 * @param {string} extractedText - The full text recognized by OCR.
 * @param {object} formInput - The data submitted via the Angular form.
 * @returns {object} - The structured verification results.
 */
function performVerification(extractedText, formInput) {
    const normalizedText = extractedText.toLowerCase();
    const results = [];
    let overallMatch = true;

    // --- 1. Brand Name Check ---
    const brandName = (formInput.brandName || '').toLowerCase().trim();
    let brandStatus = 'Not Found/Mismatch';
    
    if (brandName.length > 0 && normalizedText.includes(brandName)) {
        brandStatus = 'Match';
    } else {
        overallMatch = false;
    }
    results.push({ field: 'Brand Name', status: brandStatus, expected: formInput.brandName });

    // --- 2. Alcohol Content (ABV) Check ---
    const alcoholContent = String(formInput.alcoholContent || 0).trim();
    // Pattern to look for the ABV number followed by common symbols (%, % VOL, ALC./VOL.)
    const abvRegex = new RegExp(`\\b${alcoholContent}(\\.0)?%|${alcoholContent}(\\.0)?\\s*(alc\\.|vol\\.)`, 'i');
    let abvStatus = 'Not Found/Mismatch';
    
    if (alcoholContent !== '0' && abvRegex.test(extractedText)) {
        abvStatus = 'Match';
    } else {
        overallMatch = false;
    }
    results.push({ field: 'Alcohol Content', status: abvStatus, expected: formInput.alcoholContent + '%' });

    // --- 3. Bonus Check: Government Warning ---
    const warningText = 'government warning';
    let warningStatus = 'Not Found/Mismatch';
    
    if (normalizedText.includes(warningText)) {
        warningStatus = 'Match';
    } else {
        // Warning is mandatory, so if it's missing, it's a failure.
        overallMatch = false; 
    }
    results.push({ field: 'Government Warning', status: warningStatus, expected: warningText });

    // NOTE: Add Net Contents check here if you included it in your Angular form.

    return { 
        overall_match: overallMatch, 
        discrepancies: results 
    };
}


// --- API Route: Verify Label (Finalized) ---
app.post('/api/verify', upload.single('labelImage'), async (req, res) => {
    
    const fileInfo = req.file;
    if (!fileInfo) {
        return res.status(400).json({ success: false, message: "No image file uploaded." });
    }
    
    const imagePath = fileInfo.path;
    const formFields = req.body;
    
    let extractedText = '';
    let verificationResults = {};

    try {
        // --- 1. Google Cloud Vision API Call ---
        const [result] = await visionClient.textDetection(imagePath);
        const detections = result.textAnnotations;
        
        if (!detections || detections.length === 0) {
            // No text found by OCR (e.g., blurry image, blank label)
            verificationResults = {
                overall_match: false, 
                error: '⚠ Could not read any text from the label image. Please use a clearer image.',
                extracted_text: ''
            };
        } else {
            // The first element [0] contains the full, aggregated text
            extractedText = detections[0].description; 

            // --- 2. Perform Verification ---
            verificationResults = performVerification(extractedText, formFields);
        }

        // --- 3. Respond with Results ---
        res.json({
            success: true,
            ...verificationResults,
            extracted_text: extractedText.substring(0, 300) + (extractedText.length > 300 ? '...' : ''), // Keep text concise
            form_input: formFields
        });

    } catch (error) {
        console.error('AI/Verification Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'A server error occurred during AI processing. Check Google Vision setup.', 
            details: error.message 
        });
    } finally {
        // --- 4. Clean Up: Delete the temporary file ---
        fs.unlink(imagePath, (err) => {
            if (err) console.error('Failed to delete temp file:', err);
        });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn('⚠️ WARNING: GOOGLE_APPLICATION_CREDENTIALS not set. Vision API will likely fail.');
    }
});