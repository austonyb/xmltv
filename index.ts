import { DateTime } from 'luxon';
import { create } from 'xmlbuilder2';

// Configuration (matching PHP script)
const timezone = "America/New_York";
const lineUpID = "USA-OTA30236";
const days = 8;

// Start Bun HTTP server
console.log('Starting TV Guide server...');

Bun.serve({
  port: 3000,
  idleTimeout: 255,
  async fetch(req) {
    const startTime = Date.now();
    const url = new URL(req.url);
    
    console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);
    
    try {
      let response: Response;
      
      if (url.pathname === '/xmltv') {
        console.log('Generating XMLTV data...');
        response = await generateXml(req);
      } else {
        response = new Response('Not Found', { status: 404 });
      }
      
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname} ${response.status} - ${duration}ms`);
      
      // Add timing headers for debugging
      response.headers.set('X-Response-Time', `${duration}ms`);
      
      return response;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing request:`, error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },
});

console.log('Server running at http://localhost:3000');

/**
 * Generates XMLTV data and returns it as an HTTP response
 * @param req The incoming HTTP request
 * @returns Response containing the XMLTV data
 */
async function generateXml(req: Request): Promise<Response> {
  // Set filename date (e.g., "20231101")
  const fileDate = DateTime.now().toFormat('yyyyMMdd');
  const requestUrl = req.url;
  const now = DateTime.now().toUTC().toISO();

  // Initialize XML structure
  const xml = create({ version: '1.0', encoding: 'ISO-8859-1' })
    .ele('tv')
    .att('date', now)
    .att('source-info-url', requestUrl)
    .att('source-info-name', 'tvtv2xmltv');

  // Fetch lineup data (channels)
  const lineupUrl = `https://www.tvtv.us/api/v1/lineup/${lineUpID}/channels`;
  const lineupResponse = await fetch(lineupUrl);
  const lineupData = await lineupResponse.json() as Array<{
    stationId: string;
    channelNumber: string;
    stationCallSign: string;
    logo: string;
  }>;

  // Collect station IDs and build channel elements
  const allChannels: string[] = [];
  for (const channel of lineupData) {
    allChannels.push(channel.stationId);
    const channelEle = xml.ele('channel').att('id', channel.channelNumber);
    channelEle.ele('display-name').txt(channel.channelNumber);
    channelEle.ele('display-name').txt(channel.stationCallSign);
    channelEle.ele('icon').att('src', `https://www.tvtv.us${channel.logo}`);
  }

  // Fetch guide data for each day
  for (let day = 0; day < Math.min(days, 8); day++) {
    // Calculate start and end times (matches PHP's 04:00:00Z to 03:59:00Z next day)
    const baseDt = DateTime.now().toUTC().startOf('day');
    const startDt = baseDt.plus({ days: day }).plus({ hours: 4 });
    const endDt = baseDt.plus({ days: day + 1 }).plus({ hours: 3, minutes: 59 });
    const startTime = startDt.toISO();
    const endTime = endDt.toISO();

    // Fetch listings in batches of 20 channels
    const chunks = chunk(allChannels, 20);
    const promises = chunks.map(async (chunk) => {
      const listingUrl = `https://www.tvtv.us/api/v1/lineup/${lineUpID}/grid/${startTime}/${endTime}/${chunk.join(',')}`;
      const response = await fetch(listingUrl);
      return response.json();
    });
    const listings = (await Promise.all(promises)) as any[][];
    const listingData = listings.flat();

    // Add program elements
    for (let index = 0; index < lineupData.length; index++) {
      const channel = lineupData[index];
      const programs = listingData[index];
      if (programs && Array.isArray(programs)) {
        for (const program of programs) {
          // Convert times to local timezone
          const programStart = DateTime.fromISO(program.startTime, { zone: 'utc' }).setZone(timezone);
          const startStr = programStart.toFormat('yyyyMMddHHmmss ZZ');
          const programEnd = programStart.plus({ minutes: program.runTime });
          const endStr = programEnd.toFormat('yyyyMMddHHmmss ZZ');

          // Build programme element
          const progEle = xml.ele('programme')
            .att('start', startStr)
            .att('stop', endStr)
            .att('duration', program.duration || '') // Included for compatibility
            .att('channel', channel.channelNumber);

          progEle.ele('title').att('lang', 'en').txt(program.title || '');
          if (program.subtitle) {
            progEle.ele('sub-title').att('lang', 'en').txt(program.subtitle);
          }

          // Categories based on type
          if (program.type === 'M') {
            progEle.ele('category').att('lang', 'en').txt('movie');
          } else if (program.type === 'N') {
            progEle.ele('category').att('lang', 'en').txt('news');
          } else if (program.type === 'S') {
            progEle.ele('category').att('lang', 'en').txt('sports');
          }

          // Categories and metadata based on flags
          if (program.flags?.includes('EI')) {
            progEle.ele('category').att('lang', 'en').txt('kids');
          }
          if (program.flags?.includes('HD')) {
            progEle.ele('video').ele('quality').txt('HDTV');
          }
          if (program.flags?.includes('Stereo')) {
            progEle.ele('audio').ele('stereo').txt('stereo');
          }
          if (program.flags?.includes('New')) {
            progEle.ele('new');
          }
        }
      }
    }
  }

  // Finalize XML and create response
  const xmlString = xml.end({ prettyPrint: true });
  return new Response(xmlString, {
    headers: {
      'Content-Type': 'text/xml',
      'Content-Disposition': `attachment; filename=xmltv.${fileDate}.xml`,
    },
  });
}

/**
 * Splits an array into chunks of specified size
 * @param array The array to chunk
 * @param size The size of each chunk
 * @returns Array of chunks
 */
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}