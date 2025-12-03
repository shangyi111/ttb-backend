require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs'); // Node's File System module to delete temp files
const { ImageAnnotatorClient } = require('@google-cloud/vision'); // Google Vision API

const app = express();
const port = process.env.PORT || 3000; // Use environment variable for deployment

const credentials = process.env.GOOGLE_CREDENTIALS_JSON ? 
    JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) : 
    undefined;

// Initialize Google Vision Client
const visionClient = new ImageAnnotatorClient({credentials});

// Set up Multer to store files in a temporary 'uploads' directory
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Helper function to normalize text for case-insensitive matching.
 * Removes all non-alphanumeric characters except spaces.
 * @param {string} text - The input string.
 * @returns {string} - The normalized string.
 */
function normalize(text) {
    if (!text) return '';
    // Removes non-alphanumeric characters, converts to lower case, and trims
    return text.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").replace(/\s{2,}/g," ").trim();
}

/**
 * Performs verification checks against the extracted text.
 * @param {string} extractedText - The full text recognized by OCR.
 * @param {object} formInput - The data submitted via the Angular form.
 * @returns {object} - The structured verification results.
 */
function performVerification(extractedText, formInput) {
    const normalizedText = normalize(extractedText);
    const results = [];
    let overallMatch = true;

    // --- 0. Setup Normalized Inputs ---
    const brandName = normalize(formInput.brandName || '');
    const productClass = normalize(formInput.productClass || '');
    const netContents = normalize(formInput.netContents || '');
    const alcoholContent = String(formInput.alcoholContent || 0).trim();

    // --- 1. Brand Name Check ---
    let brandStatus = 'Not Found/Mismatch';
    if (brandName.length > 0 && normalizedText.includes(brandName)) {
        brandStatus = 'Match';
    } else {
        overallMatch = false;
    }
    results.push({ field: 'Brand Name', status: brandStatus, expected: formInput.brandName });

    // --- 2. Product Class/Type Check (New Mandatory Field) ---
    let classStatus = 'Not Found/Mismatch';
    if (productClass.length > 0 && normalizedText.includes(productClass)) {
        classStatus = 'Match';
    } else {
        overallMatch = false;
    }
    results.push({ field: 'Product Class/Type', status: classStatus, expected: formInput.productClass });

    // --- 3. Alcohol Content (ABV) Check ---
    // Look for the number followed by %, % VOL, or ALC/VOL. We use a RegEx here
    // to handle variations like '45% alc. by vol' or '45% vol'.
    const abvRegex = new RegExp(`\\b${alcoholContent}(?:\\.0)?\\s*%\\s*(?:alc\\.|vol\\.|by\\s*vol\\.)?|\\b${alcoholContent}(?:\\.0)?\\s*%`, 'i');
    let abvStatus = 'Not Found/Mismatch';
    
    if (alcoholContent !== '0' && abvRegex.test(extractedText)) {
        abvStatus = 'Match';
    } else {
        overallMatch = false;
    }
    results.push({ field: 'Alcohol Content', status: abvStatus, expected: formInput.alcoholContent + '% (within tolerance)' });

    // --- 4. Net Contents Check ---
    // Net contents often appears with variations like '750ml', '750 ml', '12 fl oz', etc.

    let netStatus = 'Not Found/Mismatch';
    let isMandatoryCheck = netContents.length > 0;
    
    // 1. Extract number and unit from form input (e.g., '750 mL' -> 750, 'mL')
    // We use a regex to capture the number and any following letters/units.
    const netContentsMatch = formInput.netContents.match(/(\d+\.?\d*)\s*([a-zA-Z]+)/i);

    if (netContentsMatch) {
        const volume = netContentsMatch[1]; // e.g., '750'
        const unit = normalize(netContentsMatch[2]); // e.g., 'ml'
        
        // Create a regex pattern to find the volume, potentially followed by a space, and the unit.
        // We handle common variations like 'fl oz' and 'mL'.
        const unitPattern = unit.replace('floz', 'fl\\s*oz|floz').replace('ml', 'm\\s*l|ml|milliliter|millilitres');

        // Regex to search for the number followed closely by the unit, allowing for minor spacing variations.
        const searchRegex = new RegExp(`\\b${volume}\\s*${unitPattern}\\b`, 'i');

        if (searchRegex.test(normalizedText)) {
            netStatus = 'Match';
        } else {
            // Only set overallMatch to false if the user provided an input that failed the check.
            if (isMandatoryCheck) overallMatch = false;
        }

    } else if (isMandatoryCheck) {
        // If the user provided input but it couldn't be parsed (e.g., just "750"), 
        // we'll try a simpler numerical inclusion check as a fallback.
        const volumeOnly = normalize(formInput.netContents).match(/(\d+\.?\d*)/);
        if (volumeOnly && normalizedText.includes(volumeOnly[1])) {
             netStatus = 'Mismatch (Unit Missing)';
             overallMatch = false; // Still mark as failure due to insufficient inpuut
        } else {
             overallMatch = false;
        }
    }
    
    // Push results to the array
    results.push({ 
        field: 'Net Contents', 
        status: netStatus, 
        expected: formInput.netContents + (isMandatoryCheck ? '' : ' (Optional)') 
    });

    // --- 5. Government Warning Check (Mandatory/Bonus) ---
    const warningPhrase = 'government warning';
    let warningStatus = 'Not Found/Mismatch';
    
    // Check for the mandatory warning phrase, handling OCR errors by normalizing
    if (normalizedText.includes(warningPhrase)) {
        warningStatus = 'Match';
    } else {
        // Warning is mandatory by law, so its absence is a failure.
        overallMatch = false; 
    }
    results.push({ field: 'Government Warning', status: warningStatus, expected: 'Phrase "GOVERNMENT WARNING" present' });

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
    if (!process.env.GOOGLE_CREDENTIALS_JSON) {
        console.warn('⚠️ WARNING: GOOGLE_APPLICATION_CREDENTIALS not set. Vision API will likely fail.');
    }
});

module.exports = {
    performVerification
};