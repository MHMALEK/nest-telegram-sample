import { Bot, Context, session, SessionFlavor, InlineKeyboard } from 'grammy';
import { Menu, MenuFlavor } from '@grammyjs/menu';
import * as dotenv from 'dotenv';
import * as contentful from 'contentful';

dotenv.config();
// eslint-disable-next-line @typescript-eslint/no-var-requires

let bot: Bot;
const telegramBotApiToken = process.env.TELEGRAM_BOT_API_TOKEN;

// 1949747267
const createBotInstance = (apiToken) => {
  const bot = new Bot(apiToken);
  return bot;
};

if (!bot) {
  bot = createBotInstance(telegramBotApiToken);
  bot.start();
}

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

const contentfullClient = contentful.createClient({
  space: process.env.IND_CONTENT_API_SPACE,
  accessToken: process.env.IND_CONTENT_API_TOKEN,
});

// api calls

const fetchIndServicesList = async () => {
  try {
    const res = await contentfullClient.getEntry('4XKP5Yd9oV0devAyvEopZl');
    return (res.fields as any).indData.data;
  } catch (e) {
    console.log(e);
  }
};

const getSoonestAppointmentDataForDesk = async (serviceCode, deskCode) => {
  const indServiceBASEAPI = process.env.IND_API_BASE_URL;
  try {
    const data = await fetch(
      `${indServiceBASEAPI}/appointments/soonest?service=${serviceCode}&desk=${deskCode}`,
    );
    const res = data.json();
    return res;
  } catch (e) {
    console.log(e);
    throw new Error(e);
  }
};

// bot util functions
const closeMenu = async (ctx) => await ctx.menu.close();
const setDeskInSession = (session, desk) => (session.selectedDesk = desk);
const setServiceInSession = (session, service) =>
  (session.selectedService = service);

//   util function
const capitalizeFirstLetter = (string) => {
  return string.charAt(0).toUpperCase() + string.slice(1);
};

type MyContext = Context & SessionFlavor<SessionData> & MenuFlavor;
interface SessionData {
  selectedService: string;
  selectedDesk: string;
}

const createSessionForBot = (bot: Bot) => {
  const defaultSessionData = {
    selectedService: null,
    selectedDesk: null,
  };
  bot.use(
    session({
      initial(): SessionData {
        return { ...defaultSessionData };
      },
    }),
  );
};

const createAndInitBot = async () => {
  const startMessageText = 'Please select a service';

  createSessionForBot(bot);

  // create menus
  const { selectServiceMenu, selectDeskMenu } =
    await createIndAppointmentMenus();

  //   make desk menu children of service menu (so navigation and back button works properly)
  selectServiceMenu.register(selectDeskMenu);

  //   initialze menu in the bot
  bot.use(selectServiceMenu);

  // start command handler
  const startHandler = (ctx) => {
    ctx.reply(startMessageText, { reply_markup: selectServiceMenu });
  };

  initBotStartCommand(bot, startHandler);

  bot.catch(console.error.bind(console));
};

const initBotStartCommand = (bot, cb) => {
  bot.command('start', (ctx) => cb(ctx));
};

const createIndAppointmentMenus = async () => {
  const { servicesCode, servicesByDesks, desks } = await fetchIndServicesList();

  const serviceMenuName = 'select-service-menu';
  const deskMenuName = 'select-desk-menu';

  const selectServiceMenu = new Menu<MyContext & SessionFlavor<any>>(
    serviceMenuName,
  );
  const selectDeskMenu = new Menu<MyContext & SessionFlavor<any>>(deskMenuName);

  const createServiceMenu = () => {
    // render menu
    for (const serviceType of servicesCode) {
      selectServiceMenu
        .submenu(
          {
            text: capitalizeFirstLetter(serviceType.label),
            payload: serviceType.code,
          },
          //  after select any item we will show the desk menu (result)
          deskMenuName,
          (ctx) => {
            // edit select service text and convert for desk menu `Please select an IND desk`
            ctx.editMessageText('Please select an IND desk');
            // save selected service to session for later usage
            setServiceInSession(ctx.session, serviceType.code);
          },
        )
        .row();
    }
  };

  const creteDeskMenu = () => {
    selectDeskMenu.dynamic((ctx: MyContext, range) => {
      // get the selected service on previous step  from session
      const selectedService = ctx.session.selectedService;

      // show error if somehow user didn't select any service
      if (typeof selectedService !== 'string')
        throw new Error('No service chosen');

      //  get the IND desks for this service
      const desksForThisService = getIndDesksByService(
        servicesByDesks,
        selectedService,
      );

      for (const desk of desksForThisService) {
        createDeskMenuItem(range, desk);
      }
    });

    //   add back button to desk menu
    selectDeskMenu.back('back to services');
  };

  const createDeskMenuItem = (range, desk) => {
    // create desk menu item based on service we have selected
    range
      .text(
        { text: capitalizeFirstLetter(desk.label), payload: desk.label }, // label and payload
        async (ctx) => {
          // if user clicked on one of the desks in this menu (except back button)
          // close the menus
          await closeMenu(ctx);
          const deskCode = desk.code;
          setDeskInSession(ctx.session, deskCode);

          // show user the selected desk and service
          await ctx.editMessageText(
            sendSelectedDeskAndServiceMessage(
              desks,
              servicesByDesks,
              ctx.session.selectedService,
              ctx.session.selectedDesk,
            ),
            { parse_mode: 'HTML' },
          );

          try {
            // fetch soonest appointment
            const res = await getSoonestAppointmentDataForDesk(
              ctx.session.selectedService,
              ctx.session.selectedDesk,
            );

            const deskLabel = desks[ctx.session.selectedDesk];

            const serviceLabel =
              servicesByDesks[ctx.session.selectedService].label;

            sendMessageShowSoonestAvailableSlot(
              ctx,
              res,
              deskLabel,
              serviceLabel,
            );

            const inlineKeyboardForCreatANotifier = new InlineKeyboard().url(
              'Select a date!',
              `${process.env.IND_WEB_APP_URL}/notifier?desk=${
                (ctx as MyContext).session.selectedDesk
              }&service=${(ctx as MyContext).session.selectedService}&userId=${
                ctx.chat.id
              }`,
            );

            await ctx.reply(
              'Do you want to be notified when a sooner timeslot become availble?',
              {
                reply_markup: inlineKeyboardForCreatANotifier,
              },
            );
          } catch (e) {
            console.log(e);
            ctx.reply(
              'We encountered a problem. it might be a problem from IND website. please /start over or try other options',
            );
          }

          await ctx.reply('Do you need a new appointment? Please /start over');
        },
      )
      .row();
  };

  createServiceMenu();
  creteDeskMenu();

  return {
    selectDeskMenu,
    selectServiceMenu,
  };
};

// message util functions
const sendMessageShowSoonestAvailableSlot = async (
  ctx,
  res,
  deskLabel,
  serviceLabel,
) => {
  const inlineKeyboardForBookAppointment = new InlineKeyboard().url(
    'Get it now!',
    `https://oap.ind.nl/oap/en/#/${ctx.session.selectedService}`,
  );

  await ctx.editMessageText(
    createMessageForSoonestAvaibleAppointment(res, serviceLabel, deskLabel),
    {
      reply_markup: inlineKeyboardForBookAppointment,
      parse_mode: 'HTML',
    },
  );
};

const createMessageForSoonestAvaibleAppointment = (
  soonestAppointmentPayload,
  selectedService,
  selectedDesk,
) => {
  return `There is an appointment availble <b>${
    soonestAppointmentPayload.date
  }</b> at <b>${
    soonestAppointmentPayload.startTime
  }</b> for ${capitalizeFirstLetter(
    selectedService,
  )} at ${capitalizeFirstLetter(selectedDesk)}!`;
};

const sendSelectedDeskAndServiceMessage = (
  desks,
  services,
  selectedService: string,
  selectedDesk: string,
) => {
  const deskLabel = desks[selectedDesk];
  const serviceLabel = services[selectedService].label;

  if (deskLabel && serviceLabel) {
    return `You have selected <b>${capitalizeFirstLetter(
      serviceLabel,
    )}</b> for ${capitalizeFirstLetter(deskLabel)}. We are working on it...`;
  } else {
    return 'We can not find the slot at the moment. Please try again later or go to IND website directly';
  }
};

// ind content functions
const getIndDesksByService = (servicesByDesks, selectedService: any) => {
  return servicesByDesks[selectedService].desks;
};

export { createAndInitBot, bot as telegramBot };
