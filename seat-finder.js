/**
 * @file seat-finder.js
 * @author [Dylan Kendall]
 * @date [2024/11/23]
 * @brief Automated course seat availability checker for Miami University
 * @version 1.0
 * 
 * @details
 * This application monitors Miami University course availability and sends email
 * notifications when seats become available in specified courses. It requires
 * connection to Miami University's network and a valid Miami email address.
 * 
 * Features:
 * - Multiple CRN monitoring
 * - Real-time email notifications
 * - Automatic network connectivity checks
 * - Miami University authentication integration
 * 
 * @requires nodemailer
 * @requires puppeteer
 * @requires readline
 * @requires prompt-sync
 * @requires dns
 */

import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import readline from 'readline';
import promptSync from 'prompt-sync';
import dns from 'dns';
import { promisify } from 'util';

// Constants
const DNS_LOOKUP = promisify(dns.lookup);
const PROMPT = promptSync({sigint: true});
const CHECK_INTERVAL = 120000; // 2 minutes in milliseconds
const MIAMI_DNS = 'mualmaip11.mcs.miamioh.edu';
const MIAMI_COURSE_URL = 'https://www.apps.miamioh.edu/courselist/';
const MIAMI_EMAIL_DOMAIN = '@miamioh.edu';

/**
 * @class CourseMonitor
 * @brief Tracks the status of monitored courses and email confirmation status
 */
class CourseMonitor {
    /**
     * @brief Initializes a new CourseMonitor instance
     */
    constructor() {
        this.courses = new Map();
        this.confirmationSent = false;
    }

    /**
     * @brief Adds a new course to monitor
     * @param {string} crn - Course Reference Number
     */
    addCourse(crn) {
        this.courses.set(crn, {
            lastStatus: null,
            checking: true
        });
    }

    /**
     * @brief Returns all monitored CRNs
     * @return {Array<string>} Array of monitored CRNs
     */
    getCRNs() {
        return Array.from(this.courses.keys());
    }

    /**
     * @brief Checks if confirmation email has been sent
     * @return {boolean} True if confirmation was sent
     */
    isConfirmationSent() {
        return this.confirmationSent;
    }

    /**
     * @brief Marks confirmation email as sent
     */
    markConfirmationSent() {
        this.confirmationSent = true;
    }
}

const monitor = new CourseMonitor();

/**
 * @brief Verifies connection to Miami University network
 * @return {Promise<boolean>} True if connected to Miami network
 */
async function checkMiamiConnection() {
    try {
        await DNS_LOOKUP(MIAMI_DNS);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * @brief Creates an email transport configuration
 * @param {string} email - User's Miami email address
 * @return {nodemailer.Transporter} Configured email transporter
 */
function createEmailTransport(email) {
    return nodemailer.createTransport({
        host: MIAMI_DNS,
        port: 587,
        secure: false,
        tls: {
            rejectUnauthorized: false
        },
        auth: {
            user: email,
        }
    });
}

/**
 * @brief Sends confirmation email for monitored courses
 * @param {Array<string>} crns - Array of CRNs being monitored
 * @param {string} email - User's Miami email address
 * @throws {Error} If email sending fails
 */
async function sendConfirmationEmail(crns, email) {
    const transporter = createEmailTransport(email);
    const crnList = crns.join(', ');
    
    const mailOptions = {
        from: email,
        to: email,
        subject: `Course Monitor Started for Multiple CRNs`,
        text: `
            Hello!

            This email confirms that we've started monitoring the following courses for available seats:
            
            CRNs: ${crnList}
            
            You will receive a separate email notification as soon as a seat becomes available in any of these courses.
            
            Important Notes:
            - The monitoring program must remain running to receive notifications
            - You will be notified immediately when a seat opens up
            - Checks occur every 2 minutes
            - You must stay connected to Miami's network
            
            Best of luck with your registration!
            
            Note: This is an automated message from the MU Seat Finder application.
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent successfully!');
        return true;
    } catch (error) {
        throw new Error('Failed to send confirmation email. Please check your network connection and email address.');
    }
}

/**
 * @brief Sends notification email when seats become available
 * @param {string} crn - Course Reference Number
 * @param {number} current - Current enrollment
 * @param {number} max - Maximum enrollment
 * @param {string} email - User's Miami email address
 * @throws {Error} If email sending fails
 */
async function sendEmailNotification(crn, current, max, email) {
    const transporter = createEmailTransport(email);
    
    const mailOptions = {
        from: email,
        to: email,
        subject: `Course ${crn} Has Available Seats!`,
        text: `
            Good news! Course ${crn} has available seats.
            Current enrollment: ${current}/${max}
            Available seats: ${max - current}
            
            Note: This is an automated message from the MU Seat Finder application.
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully!');
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        console.log('Please check your Miami email and network connection.');
        throw error;
    }
}

/**
 * @brief Searches for available seats in monitored courses
 * @param {string} email - User's Miami email address
 */
async function searchCourses(email) {
    const isConnected = await checkMiamiConnection();
    if (!isConnected) {
        console.error('\nERROR: Not connected to Miami University network!');
        console.log('Please make sure you are either:');
        console.log('1. Connected to Miami\'s campus network');
        console.log('2. Connected to Miami\'s VPN');
        console.log('3. Using MU-WIRELESS\n');
        console.log('The program will retry in 1 minute...\n');
        
        await new Promise(resolve => setTimeout(resolve, 60000));
        return searchCourses(email);
    }

    if (!monitor.isConfirmationSent()) {
        try {
            await sendConfirmationEmail(monitor.getCRNs(), email);
            monitor.markConfirmationSent();
        } catch (error) {
            console.error('\nERROR: Could not send confirmation email.');
            console.log('Please verify:');
            console.log('1. You entered your Miami email correctly');
            console.log('2. You are connected to Miami\'s network');
            console.log('3. Your Miami email account is working properly\n');
            
            const retry = PROMPT('Would you like to retry? (y/n): ').toLowerCase();
            if (retry !== 'y') {
                console.log('Program terminated.');
                process.exit(1);
            }
        }
    }

    const browser = await puppeteer.launch({
        headless: true,
    });

    try {
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(30000);
        
        try {
            await page.goto(MIAMI_COURSE_URL, {
                waitUntil: 'networkidle0'
            });
        } catch (error) {
            console.error('\nERROR: Could not access the course list website.');
            console.log('Please verify you are connected to Miami\'s network.');
            throw error;
        }

        // Setup page filters
        await page.waitForSelector('#termFilter');
        await page.select('#termFilter', '202520');

        await page.waitForSelector('.ms-choice');
        await page.click('.ms-choice');

        await new Promise(resolve => setTimeout(resolve, 1000));

        await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('label'));
            const oxfordLabel = labels.find(label => label.textContent.includes('Oxford'));
            if (oxfordLabel) {
                const checkbox = oxfordLabel.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.click();
            }
        });

        await page.click('body');
        await page.waitForSelector('#advancedLink');
        await page.click('#advancedLink');

        // Check each CRN
        for (const crn of monitor.getCRNs()) {
            await page.$eval('#crnNumber', el => el.value = '');
            await page.type('#crnNumber', crn.toString());
            await page.waitForSelector('#courseSearch:not([disabled])');
            await page.click('#courseSearch');

            try {
                await page.waitForSelector(`#statusMessage${crn}`, { timeout: 5000 });

                const statusMessage = await page.evaluate((crn) => {
                    const element = document.querySelector(`#statusMessage${crn}`);
                    return element ? element.innerText.trim() : null;
                }, crn);

                if (statusMessage) {
                    console.log(`\nCRN ${crn} Status: ${statusMessage}`);
                    const [current, max] = statusMessage.split('/').map(num => parseInt(num));
                    
                    if (!isNaN(current) && !isNaN(max)) {
                        const availableSeats = max - current;
                        console.log(`Available Seats: ${availableSeats}`);
                        
                        if (availableSeats > 0) {
                            console.log(`Seat available in CRN ${crn}! Sending email notification...`);
                            await sendEmailNotification(crn, current, max, email);
                            monitor.courses.delete(crn);
                        }
                    }
                } else {
                    console.log(`Status message not found for CRN ${crn}`);
                }
            } catch (error) {
                console.error(`Error checking CRN ${crn}:`, error.message);
                if (error.name === 'TimeoutError') {
                    console.error('Timeout: Could not find the status message.');
                    console.log('Possible reasons:');
                    console.log('1. The course might not exist');
                    console.log('2. Network connection is slow');
                    console.log('3. Miami\'s website might be experiencing issues\n');
                }
            }
        }

        if (monitor.courses.size > 0) {
            console.log('\nChecking again in 2 minutes...');
            await browser.close();
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
            return searchCourses(email);
        } else {
            console.log('\nAll courses have available seats. Program will now exit.');
            process.exit(0);
        }

    } catch (error) {
        console.error('Error:', error.message);
        console.log('Retrying in 2 minutes...');
        await browser.close();
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        return searchCourses(email);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * @brief Main program entry point
 */
async function main() {
    try {
        console.clear();
        console.log('\n=== Welcome to the MU Course Seat Finder ===\n');
        console.log('Important Notes:');
        console.log('1. You must use your Miami University email (@miamioh.edu)');
        console.log('2. You must be connected to Miami\'s network or VPN');
        console.log('3. The program will check every 2 minutes until seats are found');
        console.log('4. Press Ctrl+C at any time to stop the program\n');

        const email = PROMPT('Enter your Miami email (uniqueid@miamioh.edu): ');
        if (!email.endsWith(MIAMI_EMAIL_DOMAIN)) {
            throw new Error('Please use a valid Miami University email address.');
        }

        let gettingCRNs = true;
        while (gettingCRNs) {
            const crn = PROMPT('Enter a course CRN (or press Enter to finish): ').trim();
            if (crn === '') {
                if (monitor.courses.size === 0) {
                    console.log('Please enter at least one CRN.');
                    continue;
                }
                gettingCRNs = false;
            } else {
                monitor.addCourse(crn);
                console.log(`Added CRN ${crn} to monitoring list.`);
            }
        }

        const isConnected = await checkMiamiConnection();
        if (!isConnected) {
            console.error('\nERROR: Not connected to Miami University network!');
            console.log('Please connect to:');
            console.log('1. Miami\'s campus network');
            console.log('2. Miami\'s VPN');
            console.log('3. MU-WIRELESS\n');
            process.exit(1);
        }

        console.log('\nStarting seat checker...');
        console.log('The program will notify you when seats become available.');
        console.log('You will receive a confirmation email shortly.');
        console.log('Leave this window open to continue checking.\n');

        await searchCourses(email);
        
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

main();