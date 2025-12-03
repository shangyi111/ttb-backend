const assert = require('assert');
const test = require('node:test');

const { performVerification } = require('./server'); 

// Mock OCR text simulating the sample label image
const MOCK_OCR_TEXT = `
    OLD TOM DISTILLERY
    Est. 1878
    Kentucky Straight Bourbon Whiskey
    45% Alc./Vol. (90 Proof)
    NET CONTENTS: 750 ML
    GOVERNMENT WARNING: 
    (1) ACCORDING TO THE SURGEON GENERAL...
`;

test('Test 1: Full Success Scenario', () => {
    const formInput = {
        brandName: 'Old Tom Distillery',
        productClass: 'Kentucky Straight Bourbon Whiskey',
        alcoholContent: 45,
        netContents: '750 mL'
    };

    const results = performVerification(MOCK_OCR_TEXT, formInput);

    assert.strictEqual(results.overall_match, true, 'Overall match failed when it should have passed.');
    assert.ok(results.discrepancies.every(d => d.status.includes('Match')), 'Not all checks returned "Match".');
});


test('Test 2: Failure Scenario (Brand Name Mismatch)', () => {
    const formInput = {
        brandName: 'Old SAM Distillery', // Intentional mismatch
        productClass: 'Kentucky Straight Bourbon Whiskey',
        alcoholContent: 45,
        netContents: '750 mL'
    };

    const results = performVerification(MOCK_OCR_TEXT, formInput);

    assert.strictEqual(results.overall_match, false, 'Overall match passed when Brand Name was mismatched.');
    const brandCheck = results.discrepancies.find(d => d.field === 'Brand Name');
    assert.strictEqual(brandCheck.status, 'Not Found/Mismatch', 'Brand Name status was incorrect.');
});


test('Test 3: Normalization/ABV Tolerance Check', () => {
    const formInput = {
        brandName: 'OLD TOM DISTILLERY', 
        productClass: 'Bourbon Whiskey', 
        alcoholContent: 45.0,
        netContents: '750ML' 
    };

    const results = performVerification(MOCK_OCR_TEXT, formInput);
    
    assert.strictEqual(results.overall_match, true, 'ABV check failed normalization.');
});


test('Test 4: Net Contents Failure (Unit Missing)', () => {
    const formInput = {
        brandName: 'Old Tom Distillery',
        productClass: 'Kentucky Straight Bourbon Whiskey',
        alcoholContent: 45,
        netContents: '750' // Missing unit, should be treated as insufficient input
    };

    const results = performVerification(MOCK_OCR_TEXT, formInput);

    assert.strictEqual(results.overall_match, false, 'Net Contents failure was not detected.');
});