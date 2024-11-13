import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import readline from 'readline';
import promptSync from 'prompt-sync';
import dns from 'dns';
import { promisify } from 'util';
const dnsLookup = promisify(dns.lookup);
const prompt = promptSync({sigint: true});

const CHECK_INTERVAL = 120000; // 2 minutes in milliseconds

// Track confirmation status and course data for each CRN
class CourseMonitor {
    constructor() {
        this.courses = new Map(); // Map to store course data
        this.confirmationSent = false;
    }

    addCourse(crn) {
        this.courses.set(crn, {
            lastStatus: null,
            checking: true
        });
    }

    getCRNs() {
        return Array.from(this.courses.keys());
    }

    isConfirmationSent() {
        return this.confirmationSent;
    }

    markConfirmationSent() {
        this.confirmationSent = true;
    }
}

const monitor = new CourseMonitor();

async function checkMiamiConnection() {
    try {
        await dnsLookup('mualmaip11.mcs.miamioh.edu');
        return true;
    } catch (error) {
        return false;
    }
}

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

    // Send single confirmation email for all CRNs if not sent yet
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
            
            const retry = prompt('Would you like to retry? (y/n): ').toLowerCase();
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
            await page.goto('https://www.apps.miamioh.edu/courselist/', {
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
                if (checkbox) {
                    checkbox.click();
                }
            }
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.click('body');

        await page.waitForSelector('#advancedLink');
        await page.click('#advancedLink');

        // Check each CRN
        for (const crn of monitor.getCRNs()) {
            // Clear previous CRN
            await page.$eval('#crnNumber', el => el.value = '');
            
            // Enter new CRN
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
                            // Remove this CRN from monitoring
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

        // Continue monitoring if there are still courses to check
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

async function sendConfirmationEmail(crns, email) {
    const transporter = nodemailer.createTransport({
        host: 'mualmaip11.mcs.miamioh.edu',
        port: 587,
        secure: false,
        tls: {
            rejectUnauthorized: false
        },
        auth: {
            user: email,
        }
    });

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

async function sendEmailNotification(crn, current, max, email) {
    const transporter = nodemailer.createTransport({
        host: 'mualmaip11.mcs.miamioh.edu',
        port: 587,
        secure: false,
        tls: {
            rejectUnauthorized: false
        },
        auth: {
            user: email,
        }
    });

    const mailOptions = {
        from: email,
        to: email,
        subject: `Course ${crn} Has Available Seats!`,
        text: `
            Good news! Course ${crn} has available seats.
            Current enrollment: ${current}/${max}
            Available seats: ${max - current}
            
            Register now at: https://www.apps.miamioh.edu/courselist/
            
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

async function main() {
    try {
        console.clear();
        console.log('\n=== Welcome to the MU Course Seat Finder ===\n');
        console.log('Important Notes:');
        console.log('1. You must use your Miami University email (@miamioh.edu)');
        console.log('2. You must be connected to Miami\'s network or VPN');
        console.log('3. The program will check every 2 minutes until seats are found');
        console.log('4. Press Ctrl+C at any time to stop the program\n');

        const email = prompt('Enter your Miami email (uniqueid@miamioh.edu): ');
        if (!email.endsWith('@miamioh.edu')) {
            throw new Error('Please use a valid Miami University email address.');
        }

        // Get multiple CRNs
        let gettingCRNs = true;
        while (gettingCRNs) {
            const crn = prompt('Enter a course CRN (or press Enter to finish): ').trim();
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